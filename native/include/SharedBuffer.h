/**
 * @file SharedBuffer.h
 * @brief Merged interleaved schedule from all SV publishers
 *
 * Each SvPublisherInstance pre-builds a frame cache for one full second of
 * its own stream. SharedBuffer merges those caches into a single
 * timestamp-ordered playback schedule that the writer pool walks.
 *
 *   Publisher #1 frame cache  ╲
 *   Publisher #2 frame cache  ──→  SharedBuffer  ──→  Writer pool
 *   …                          ╱
 *
 * Properties:
 *   - Built once at start; immutable while the writer is running.
 *   - Holds raw pointers into the publishers' frame caches (zero copy);
 *     publishers must outlive the SharedBuffer.
 *   - Sorted by timestamp_us so workers can stride through it lock-free.
 *   - Publisher streams are staggered evenly across the shortest interval
 *     so the merged stream doesn't bunch up.
 */

#ifndef SHARED_BUFFER_H
#define SHARED_BUFFER_H

#include "sv_publisher_instance.h"

#include <vector>
#include <memory>
#include <cstdint>
#include <cstddef>

class SvPublisherInstance;   /* forward decl — actual class lives in its own header */

/** One slot in the shared schedule. */
struct ScheduleEntry {
    uint64_t timestamp_us;             /* When to transmit (relative to cycle start) */
    uint8_t* framePtr;                 /* Borrowed pointer into a publisher's frame cache */
    uint16_t frameLen;                 /* Frame length in bytes */
    uint16_t _pad;                     /* alignment */
    uint32_t publisherId;              /* Which publisher this frame came from */
    uint32_t frameIdx;                 /* Index within owner's frame cache — needed
                                        * for live re-encode (smpCnt depends on it) */
    SvPublisherInstance* publisher;    /* Cached owner pointer — O(1) dispatch in
                                        * the hot writer loop. Borrowed; the
                                        * publisher outlives the SharedBuffer. */
};

class SharedBuffer {
public:
    /** Drop the schedule and release the borrowed pointers. */
    void clear();

    /**
     * Build the interleaved schedule from all READY publishers.
     * Frames are sorted by `timestamp_us`; ties break by `publisherId` for
     * deterministic playback order.
     */
    void buildFromPublishers(
        const std::vector<std::unique_ptr<SvPublisherInstance>>& publishers);

    /*--- Read-only access for the writer pool ---*/
    size_t               size()  const { return m_schedule.size(); }
    bool                 empty() const { return m_schedule.empty(); }
    const ScheduleEntry& operator[](size_t idx) const { return m_schedule[idx]; }
    const ScheduleEntry* data()                  const { return m_schedule.data(); }

    /** Duration of one complete cycle in microseconds. */
    uint64_t getCycleDuration() const { return m_cycleDuration_us; }

private:
    std::vector<ScheduleEntry> m_schedule;
    uint64_t                   m_cycleDuration_us = 0;
};

#endif /* SHARED_BUFFER_H */
