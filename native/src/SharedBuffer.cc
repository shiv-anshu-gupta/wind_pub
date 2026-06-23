/**
 * @file SharedBuffer.cc
 * @brief Implementation of the merged SV schedule
 *
 * Extracted from PublisherController.cc so the timeline merging code lives
 * with its own header. See SharedBuffer.h for the architectural role.
 */

#include "../include/SharedBuffer.h"

#include <algorithm>
#include <climits>
#include <cstdio>

void SharedBuffer::clear()
{
    m_schedule.clear();
    m_cycleDuration_us = 0;
}

void SharedBuffer::buildFromPublishers(
    const std::vector<std::unique_ptr<SvPublisherInstance>>& publishers)
{
    m_schedule.clear();
    m_cycleDuration_us = 0;

    /* Count READY publishers and the total schedule slots they contribute. */
    int    readyCount  = 0;
    size_t totalFrames = 0;
    for (const auto& pub : publishers) {
        if (pub->getState() == SvPublisherInstance::READY) {
            totalFrames += static_cast<size_t>(pub->getFrameCount());
            ++readyCount;
        }
    }

    if (readyCount == 0 || totalFrames == 0) {
        printf("[shared-buffer] No ready publishers\n");
        return;
    }

    m_schedule.reserve(totalFrames);

    /* Stagger publishers evenly across time so the merged stream doesn't
     * bunch up. Example with 2 streams both at 250 us:
     *
     *     t=  0us: P1 frame 0
     *     t=125us: P2 frame 0    (= P1 interval / 2)
     *     t=250us: P1 frame 1
     *     t=375us: P2 frame 1
     *     …
     *
     * Stagger step = (shortest interval) / (number of ready publishers). */
    uint64_t minInterval_us = UINT64_MAX;
    for (const auto& pub : publishers) {
        if (pub->getState() != SvPublisherInstance::READY) continue;
        const uint64_t pps = pub->getPacketsPerSec();
        if (pps == 0) continue;
        const uint64_t interval = 1000000ULL / pps;
        if (interval < minInterval_us) minInterval_us = interval;
    }
    if (minInterval_us == UINT64_MAX) minInterval_us = 250;

    const uint64_t staggerStep =
        minInterval_us / static_cast<uint64_t>(readyCount);
    int pubIndex = 0;

    for (const auto& pub : publishers) {
        if (pub->getState() != SvPublisherInstance::READY) continue;

        const uint64_t pps         = pub->getPacketsPerSec();
        const uint64_t interval_us = (pps > 0) ? (1000000ULL / pps) : 250;
        const uint64_t offset_us   =
            static_cast<uint64_t>(pubIndex) * staggerStep;

        for (int i = 0; i < pub->getFrameCount(); ++i) {
            ScheduleEntry entry;
            entry.timestamp_us = offset_us + static_cast<uint64_t>(i) * interval_us;
            entry.framePtr     = pub->getFrame(i);
            entry.frameLen     = static_cast<uint16_t>(pub->getFrameLen(i));
            entry._pad         = 0;
            entry.publisherId  = pub->getId();
            entry.frameIdx     = static_cast<uint32_t>(i);
            entry.publisher    = pub.get();
            m_schedule.push_back(entry);

            /* Track furthest-out timestamp — cycle duration is the latest
             * frame's slot + one interval (its "playback end"). */
            if (entry.timestamp_us + interval_us > m_cycleDuration_us)
                m_cycleDuration_us = entry.timestamp_us + interval_us;
        }
        ++pubIndex;
    }

    /* Sort the merged timeline by timestamp; tie-break by publisherId so
     * playback order is deterministic. */
    std::sort(m_schedule.begin(), m_schedule.end(),
        [](const ScheduleEntry& a, const ScheduleEntry& b) {
            if (a.timestamp_us != b.timestamp_us)
                return a.timestamp_us < b.timestamp_us;
            return a.publisherId < b.publisherId;
        });

    printf("[shared-buffer] Built schedule: %zu entries from %d publishers, "
           "cycle: %llu us\n",
           m_schedule.size(), readyCount,
           static_cast<unsigned long long>(m_cycleDuration_us));
}
