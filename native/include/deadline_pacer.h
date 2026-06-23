/*
 * deadline_pacer.h — resource-efficient, kernel-parked packet pacing.
 *
 * Shared by the single-publisher loop (SvPublisher.cc) and the
 * multi-publisher writer loop (PublisherController.cc) so the timing logic lives in
 * exactly one place.
 *
 * Design goals:
 *   - NEVER busy-wait. The thread is parked in the kernel until each packet's
 *     absolute deadline; CPU scales with real send work, not with the rate.
 *   - NO cap on the configured rate. At steady state one packet is due per
 *     wake (even spacing); bursts appear only when the OS woke us late, which
 *     is exactly when catching up is unavoidable.
 *   - Minimal syscalls: one clock_nanosleep per sleep (no extra clock_gettime),
 *     and clock reads amortised per burst rather than per packet.
 */
#ifndef SV_DEADLINE_PACER_H
#define SV_DEADLINE_PACER_H

#include <chrono>
#include <cstdint>

#ifdef _WIN32
#include <thread>
#else
#include <ctime>
#include <cerrno>
#endif

namespace sv {

/* Largest number of packets a single wake-up may emit while catching up after a
 * scheduling stall, so a long preemption cannot turn into an unbounded flood. */
inline constexpr int kMaxCatchupBurst = 256;

/* Block until an absolute steady_clock deadline without busy-waiting. */
inline void sleep_until_deadline(std::chrono::steady_clock::time_point tp)
{
#ifdef _WIN32
    std::this_thread::sleep_until(tp);
#else
    /* On Linux, std::chrono::steady_clock is clock_gettime(CLOCK_MONOTONIC),
     * so the time_point's epoch already matches CLOCK_MONOTONIC. Convert it
     * straight to a timespec and sleep with a SINGLE syscall — no second
     * clock_gettime, and TIMER_ABSTIME means no accumulated drift. */
    const long long ns =
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            tp.time_since_epoch()).count();
    struct timespec t;
    t.tv_sec  = static_cast<time_t>(ns / 1000000000LL);
    t.tv_nsec = static_cast<long>(ns % 1000000000LL);
    /* Re-enter on signal interruption against the same absolute target. */
    while (clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &t, nullptr) == EINTR)
        ;
#endif
}

/*
 * Epoch-anchored absolute-deadline pacer.
 *
 *   target[N] = epoch + N * interval
 *
 * The average rate is exactly 1/interval regardless of how long each send
 * takes. Usage:
 *
 *     sv::DeadlinePacer pacer(intervalNs);
 *     while (running) {
 *         int n = pacer.wait_due(sv::kMaxCatchupBurst);  // blocks, returns >=1
 *         int sent = 0;
 *         for (; sent < n && running; ++sent) send_one_packet();
 *         pacer.advance(sent);
 *     }
 */
class DeadlinePacer {
public:
    explicit DeadlinePacer(std::chrono::nanoseconds interval)
        : interval_(interval <= std::chrono::nanoseconds::zero()
                        ? std::chrono::nanoseconds(1) : interval),
          epoch_(std::chrono::steady_clock::now()) {}

    /* Block until at least one packet is due, then report how many may be sent
     * right now (1..maxBurst). Returns 1 at steady state; more only when we
     * woke late and must catch up. */
    int wait_due(int maxBurst)
    {
        auto now    = std::chrono::steady_clock::now();
        auto target = epoch_ + pktNum_ * interval_;

        if (target > now) {
            sleep_until_deadline(target);
            now = std::chrono::steady_clock::now();
        }

        int due = 0;
        while (due < maxBurst &&
               epoch_ + (pktNum_ + static_cast<uint64_t>(due)) * interval_ <= now)
            ++due;

        return due > 0 ? due : 1;   /* always make forward progress */
    }

    /* Advance past `count` emitted packets. If we are still more than one
     * interval behind after the burst, the configured rate exceeds what this
     * machine can emit — re-anchor so backlog cannot grow without bound. */
    void advance(int count)
    {
        pktNum_ += static_cast<uint64_t>(count);

        auto now    = std::chrono::steady_clock::now();
        auto target = epoch_ + pktNum_ * interval_;
        if (target <= now && (now - target) > interval_) {
            epoch_  = now;
            pktNum_ = 0;
        }
    }

private:
    std::chrono::nanoseconds              interval_;
    std::chrono::steady_clock::time_point epoch_;
    uint64_t                              pktNum_ = 0;
};

} // namespace sv

#endif /* SV_DEADLINE_PACER_H */
