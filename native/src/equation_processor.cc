/**
 * @file equation_processor.cc
 * @brief Equation Processing Implementation
 * 
 * Parses waveform equations and generates samples for IEC 61850-9-2LE.
 */

#include "equation_processor.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <ctype.h>

/* MSVC names these strtok_s / _strdup; MinGW-w64 provides the POSIX strtok_r /
 * strdup natively, so only remap under MSVC. */
#if defined(_WIN32) && defined(_MSC_VER)
#define strtok_r strtok_s
#define strdup _strdup
#endif

/*============================================================================
 * Helper Functions
 *============================================================================*/

static void trim(char* str) {
    if (!str || !*str) return;
    
    char* start = str;
    while (*start && isspace((unsigned char)*start)) start++;
    
    char* end = start + strlen(start) - 1;
    while (end > start && isspace((unsigned char)*end)) *end-- = '\0';
    
    if (start != str) memmove(str, start, strlen(start) + 1);
}

static const char* find_ci(const char* str, const char* pattern) {
    if (!str || !pattern) return NULL;
    
    size_t slen = strlen(str), plen = strlen(pattern);
    if (plen > slen) return NULL;
    
    for (size_t i = 0; i <= slen - plen; i++) {
        int match = 1;
        for (size_t j = 0; j < plen && match; j++) {
            if (tolower((unsigned char)str[i+j]) != tolower((unsigned char)pattern[j])) 
                match = 0;
        }
        if (match) return str + i;
    }
    return NULL;
}

/*============================================================================
 * Equation Parsing
 *============================================================================*/

static double parse_amplitude(const char* eq) {
    if (!eq) return 0.0;
    
    const char* star = strchr(eq, '*');
    if (!star) return atof(eq);
    
    char buf[64];
    size_t len = star - eq;
    if (len >= sizeof(buf)) len = sizeof(buf) - 1;
    strncpy(buf, eq, len);
    buf[len] = '\0';
    trim(buf);
    
    return atof(buf);
}

static double parse_frequency(const char* eq, double defaultFreq) {
    if (!eq) return defaultFreq;
    
    /* Normalize string */
    char norm[EQ_MAX_EQUATION_LEN];
    size_t j = 0;
    for (size_t i = 0; eq[i] && j < sizeof(norm) - 1; i++) {
        if (!isspace((unsigned char)eq[i])) {
            norm[j++] = tolower((unsigned char)eq[i]);
        }
    }
    norm[j] = '\0';
    
    /* Find "pi*" pattern */
    const char* pi = strstr(norm, "pi*");
    if (!pi) pi = strstr(norm, "pi ");
    if (!pi) return defaultFreq;
    
    const char* start = pi + 3;
    while (*start == '*' || *start == ' ') start++;
    
    const char* end = strstr(start, "*t");
    if (!end) end = strchr(start, 't');
    if (!end) end = strchr(start, ')');
    if (!end) return defaultFreq;
    
    char buf[32];
    size_t len = end - start;
    while (len > 0 && (start[len-1] == '*' || start[len-1] == ' ')) len--;
    if (len >= sizeof(buf)) len = sizeof(buf) - 1;
    
    strncpy(buf, start, len);
    buf[len] = '\0';
    
    double freq = atof(buf);
    return (freq > 0 && freq < 1e9) ? freq : defaultFreq;
}

static double parse_phase(const char* eq) {
    if (!eq) return 0.0;
    
    char norm[EQ_MAX_EQUATION_LEN];
    size_t j = 0;
    for (size_t i = 0; eq[i] && j < sizeof(norm) - 1; i++) {
        if (!isspace((unsigned char)eq[i])) {
            norm[j++] = tolower((unsigned char)eq[i]);
        }
    }
    norm[j] = '\0';
    
    const char* t = strstr(norm, "*t");
    if (!t) t = strchr(norm, 't');
    if (!t) return 0.0;
    
    const char* after = t + 1;
    if (*after == '*') after++;
    
    /* Common phase patterns */
    if (strstr(after, "-2*pi/3") || strstr(after, "-2pi/3")) return -EQ_TWO_PI / 3.0;
    if (strstr(after, "+2*pi/3") || strstr(after, "+2pi/3") || strstr(after, "2*pi/3")) return EQ_TWO_PI / 3.0;
    if (strstr(after, "-4*pi/3") || strstr(after, "-4pi/3")) return -4.0 * EQ_PI / 3.0;
    if (strstr(after, "+4*pi/3") || strstr(after, "+4pi/3")) return 4.0 * EQ_PI / 3.0;
    if (strstr(after, "-pi/2")) return -EQ_PI / 2.0;
    if (strstr(after, "+pi/2")) return EQ_PI / 2.0;
    
    return 0.0;
}

static EqWaveformType parse_wavetype(const char* eq) {
    if (!eq) return EQ_WAVE_SINE;
    if (find_ci(eq, "cos(")) return EQ_WAVE_COSINE;
    if (find_ci(eq, "square") || find_ci(eq, "sqr(")) return EQ_WAVE_SQUARE;
    if (find_ci(eq, "triangle") || find_ci(eq, "tri(")) return EQ_WAVE_TRIANGLE;
    return EQ_WAVE_SINE;
}

/*============================================================================
 * Core API
 *============================================================================*/

int eq_processor_init(EqProcessor* proc, double defaultFreq, uint32_t sampleRate) {
    if (!proc) return -1;
    
    /* Free any existing wavetables before zeroing */
    eq_free_all_wavetables(proc);
    
    memset(proc, 0, sizeof(EqProcessor));
    proc->defaultFrequency = defaultFreq;
    proc->sampleRate = sampleRate;
    
    for (int i = 0; i < EQ_MAX_CHANNELS; i++) {
        proc->channels[i].frequency = defaultFreq;
        proc->channels[i].scaleFactor = 1000.0;
        proc->channels[i].isZero = 1;
        proc->channels[i].wavetable = NULL;
        proc->channels[i].wavetableSize = 0;
        proc->channels[i].useWavetable = 0;
        proc->channels[i].fullSecondWavetable = 0;
        proc->channels[i].stepTermCount = 0;
        proc->channels[i].hasStepResponse = 0;
    }
    
    return 0;
}

void eq_free_channel_wavetable(EqChannelData* channel) {
    if (!channel) return;
    if (channel->wavetable) {
        free(channel->wavetable);
        channel->wavetable = NULL;
    }
    channel->wavetableSize = 0;
    channel->useWavetable = 0;
    channel->fullSecondWavetable = 0;
}

void eq_free_all_wavetables(EqProcessor* proc) {
    if (!proc) return;
    for (int i = 0; i < EQ_MAX_CHANNELS; i++) {
        eq_free_channel_wavetable(&proc->channels[i]);
    }
}

void eq_processor_reset(EqProcessor* proc) {
    if (!proc) return;
    double freq = proc->defaultFrequency;
    uint32_t rate = proc->sampleRate;
    eq_processor_init(proc, freq, rate);
}

int eq_parse_wavetable(const char* wtString, EqChannelData* ch, double defaultFreq) {
    if (!ch || !wtString) return -1;
    
    /* Expected format: "WT:count:v1,v2,v3,..." */
    if (strncmp(wtString, "WT:", 3) != 0) return -1;
    
    const char* countStart = wtString + 3;
    const char* colon2 = strchr(countStart, ':');
    if (!colon2) return -1;
    
    int count = atoi(countStart);
    if (count <= 0 || count > 100000) return -1;
    
    /* Free any existing wavetable */
    eq_free_channel_wavetable(ch);
    
    ch->wavetable = (int32_t*)malloc(count * sizeof(int32_t));
    if (!ch->wavetable) return -1;
    
    const char* dataStart = colon2 + 1;
    char* dataCopy = strdup(dataStart);
    if (!dataCopy) { free(ch->wavetable); ch->wavetable = NULL; return -1; }
    
    char* saveptr;
    char* token = strtok_r(dataCopy, ",", &saveptr);
    int parsed = 0;
    
    while (token && parsed < count) {
        ch->wavetable[parsed] = (int32_t)atol(token);
        parsed++;
        token = strtok_r(NULL, ",", &saveptr);
    }
    
    free(dataCopy);
    
    /* Fill remaining slots with zero if fewer values than expected */
    for (int i = parsed; i < count; i++) {
        ch->wavetable[i] = 0;
    }
    
    ch->wavetableSize = count;
    ch->useWavetable = 1;
    ch->fullSecondWavetable = 0;
    ch->frequency = defaultFreq;
    ch->scaleFactor = 1000.0;
    ch->isZero = 0;
    ch->isValid = 1;
    ch->amplitude = 0;
    ch->phaseOffset = 0;
    ch->waveType = EQ_WAVE_SINE;
    
    strncpy(ch->equation, "[wavetable]", EQ_MAX_EQUATION_LEN - 1);
    
    printf("[eq] Parsed wavetable: %d samples\n", parsed);
    return 0;
}

int eq_parse_wavetable_full_second(const char* wtString, EqChannelData* ch, double defaultFreq) {
    if (!ch || !wtString) return -1;
    
    /* Expected format: "WTS:count:v1,v2,v3,..." */
    if (strncmp(wtString, "WTS:", 4) != 0) return -1;
    
    const char* countStart = wtString + 4;
    const char* colon2 = strchr(countStart, ':');
    if (!colon2) return -1;
    
    int count = atoi(countStart);
    if (count <= 0 || count > 100000) return -1;
    
    /* Free any existing wavetable */
    eq_free_channel_wavetable(ch);
    
    ch->wavetable = (int32_t*)malloc(count * sizeof(int32_t));
    if (!ch->wavetable) return -1;
    
    const char* dataStart = colon2 + 1;
    char* dataCopy = strdup(dataStart);
    if (!dataCopy) { free(ch->wavetable); ch->wavetable = NULL; return -1; }
    
    char* saveptr;
    char* token = strtok_r(dataCopy, ",", &saveptr);
    int parsed = 0;
    
    while (token && parsed < count) {
        ch->wavetable[parsed] = (int32_t)atol(token);
        parsed++;
        token = strtok_r(NULL, ",", &saveptr);
    }
    
    free(dataCopy);
    
    /* Fill remaining slots with zero if fewer values than expected */
    for (int i = parsed; i < count; i++) {
        ch->wavetable[i] = 0;
    }
    
    ch->wavetableSize = count;
    ch->useWavetable = 1;
    ch->fullSecondWavetable = 1;
    ch->frequency = defaultFreq;
    ch->scaleFactor = 1000.0;
    ch->isZero = 0;
    ch->isValid = 1;
    ch->amplitude = 0;
    ch->phaseOffset = 0;
    ch->waveType = EQ_WAVE_SINE;
    
    strncpy(ch->equation, "[wavetable-full-second]", EQ_MAX_EQUATION_LEN - 1);
    
    printf("[eq] Parsed full-second wavetable: %d samples\n", parsed);
    return 0;
}

/**
 * Parse step response terms from an equation containing u(t-T) patterns.
 * Looks for the multiplier section: "* (1 + coeff1*u(t-t1) + coeff2*u(t-t2))"
 * Extracts each {coefficient, stepTime} pair.
 *
 * @return Number of step terms found (0 if none).
 */
static int parse_step_terms(const char* eq, EqStepTerm* terms, int maxTerms) {
    if (!eq || !terms) return 0;

    /* Scan for every occurrence of "u(t-" */
    int count = 0;
    const char* p = eq;
    while ((p = strstr(p, "u(t-")) != NULL && count < maxTerms) {
        /* Parse the step time after "u(t-" */
        const char* timeStart = p + 4; /* skip "u(t-" */
        char* endptr;
        double stepTime = strtod(timeStart, &endptr);
        if (endptr == timeStart || stepTime < 0 || stepTime > 10.0) {
            p = timeStart;
            continue;
        }

        /* Walk backwards from "u(t-" to find the coefficient.
         * Expected patterns: "+19*u(t-0.5)", "-0.85*u(t-0.5)", "- 20 * u(t-0.7)"
         * We start from p-1, skip optional whitespace and '*', then read number+sign.
         */
        double coeff = 1.0;
        const char* q = p - 1;
        /* skip trailing whitespace and '*' */
        while (q >= eq && (*q == ' ' || *q == '*')) q--;
        if (q >= eq) {
            /* Read number backwards (digits and '.') */
            const char* numEnd = q + 1;
            while (q >= eq && (isdigit((unsigned char)*q) || *q == '.')) q--;
            /* q now points before the number; numStart..numEnd is just the digits */
            const char* numStart = q + 1;
            int neg = 0;
            if (q >= eq) {
                /* skip whitespace before sign */
                const char* signCheck = q;
                while (signCheck >= eq && *signCheck == ' ') signCheck--;
                if (signCheck >= eq && *signCheck == '-') { neg = 1; }
            }
            if (numStart < numEnd) {
                char buf[64];
                size_t len = numEnd - numStart;
                if (len >= sizeof(buf)) len = sizeof(buf) - 1;
                strncpy(buf, numStart, len);
                buf[len] = '\0';
                trim(buf);
                coeff = atof(buf);
                if (neg) coeff = -coeff;
                /* If we found just a sign with no number (e.g. bare "-u(t-...)" ) */
                if (coeff == 0.0 && neg) coeff = -1.0;
            } else if (neg) {
                coeff = -1.0;
            }
        }

        terms[count].coefficient = coeff;
        terms[count].stepTime = stepTime;
        count++;

        p = endptr; /* advance past the step time */
    }
    return count;
}

int eq_parse_equation(const char* equation, EqChannelData* ch, double defaultFreq) {
    if (!ch) return -1;
    
    ch->amplitude = 0;
    ch->frequency = defaultFreq;
    ch->phaseOffset = 0;
    ch->scaleFactor = 1000.0;
    ch->isZero = 0;
    ch->isValid = 0;
    ch->waveType = EQ_WAVE_SINE;
    ch->stepTermCount = 0;
    ch->hasStepResponse = 0;
    /* Preserve wavetable state - don't clear here */
    
    if (!equation || !equation[0] || strcmp(equation, "0") == 0 || strcmp(equation, "0.0") == 0) {
        ch->isZero = 1;
        ch->isValid = 1;
        return 0;
    }
    
    /* Check for wavetable format */
    if (strncmp(equation, "WTS:", 4) == 0) {
        return eq_parse_wavetable_full_second(equation, ch, defaultFreq);
    }
    if (strncmp(equation, "WT:", 3) == 0) {
        return eq_parse_wavetable(equation, ch, defaultFreq);
    }
    
    strncpy(ch->equation, equation, EQ_MAX_EQUATION_LEN - 1);
    ch->equation[EQ_MAX_EQUATION_LEN - 1] = '\0';
    trim(ch->equation);
    
    ch->amplitude = parse_amplitude(ch->equation);
    ch->frequency = parse_frequency(ch->equation, defaultFreq);
    ch->phaseOffset = parse_phase(ch->equation);
    ch->waveType = parse_wavetype(ch->equation);
    
    /* Parse step response terms: u(t-T) */
    if (strstr(ch->equation, "u(t-")) {
        ch->stepTermCount = parse_step_terms(ch->equation, ch->stepTerms, EQ_MAX_STEP_TERMS);
        ch->hasStepResponse = (ch->stepTermCount > 0) ? 1 : 0;
    }
    
    ch->isValid = 1;
    
    return 0;
}

int eq_load_equations(EqProcessor* proc, const char* equations) {
    if (!proc || !equations) return -1;
    
    eq_processor_reset(proc);
    
    printf("[eq] Loading equations (freq=%.0f Hz, rate=%u)\n", 
           proc->defaultFrequency, proc->sampleRate);
    
    char* str = strdup(equations);
    if (!str) return -1;
    
    char* saveptr;
    char* token = strtok_r(str, "|", &saveptr);
    int count = 0;
    
    while (token && proc->channelCount < EQ_MAX_CHANNELS) {
        char* colon = strchr(token, ':');
        if (!colon) { token = strtok_r(NULL, "|", &saveptr); continue; }
        
        *colon = '\0';
        char* id = token;
        char* eq = colon + 1;
        trim(id);
        trim(eq);
        
        EqChannelData* ch = &proc->channels[proc->channelCount];
        strncpy(ch->id, id, EQ_MAX_ID_LEN - 1);
        
        if (eq_parse_equation(eq, ch, proc->defaultFrequency) == 0) {
            if (ch->useWavetable) {
                printf("[eq] %s: WAVETABLE mode (%d samples, %s)\n", ch->id, ch->wavetableSize,
                       ch->fullSecondWavetable ? "full-second" : "per-cycle");
            } else if (ch->hasStepResponse) {
                printf("[eq] %s: amp=%.1f, freq=%.0f Hz, phase=%.1f°, STEP(",
                       ch->id, ch->amplitude, ch->frequency, ch->phaseOffset * 180.0 / EQ_PI);
                for (int s = 0; s < ch->stepTermCount; s++) {
                    printf("%+.2f@%.3fs%s", ch->stepTerms[s].coefficient, ch->stepTerms[s].stepTime,
                           s < ch->stepTermCount - 1 ? " " : "");
                }
                printf(")\n");
            } else {
                printf("[eq] %s: amp=%.1f, freq=%.0f Hz, phase=%.1f°\n",
                       ch->id, ch->amplitude, ch->frequency, ch->phaseOffset * 180.0 / EQ_PI);
            }
            proc->channelCount++;
            count++;
        } else {
            proc->parseErrors++;
        }
        
        token = strtok_r(NULL, "|", &saveptr);
    }
    
    free(str);
    printf("[eq] Loaded %d channels\n", count);
    return count;
}

int eq_set_channel_equation(EqProcessor* proc, const char* channelId, const char* equation) {
    if (!proc || !channelId) return -1;
    
    int idx = -1;
    for (int i = 0; i < proc->channelCount; i++) {
        if (strcmp(proc->channels[i].id, channelId) == 0) { idx = i; break; }
    }
    
    if (idx < 0) {
        if (proc->channelCount >= EQ_MAX_CHANNELS) return -1;
        idx = proc->channelCount++;
        strncpy(proc->channels[idx].id, channelId, EQ_MAX_ID_LEN - 1);
    }
    
    return eq_parse_equation(equation, &proc->channels[idx], proc->defaultFrequency);
}

/*============================================================================
 * Sample Generation
 *============================================================================*/

int32_t eq_generate_sample(const EqChannelData* ch, double t) {
    if (!ch || ch->isZero || !ch->isValid) return 0;
    
    /* Wavetable mode: look up pre-computed value */
    if (ch->useWavetable && ch->wavetable && ch->wavetableSize > 0) {
        if (ch->fullSecondWavetable) {
            /* Full-second wavetable: index maps across entire 1.0s frame */
            double pos = fmod(t, 1.0);
            if (pos < 0) pos += 1.0;
            int index = (int)(pos * ch->wavetableSize);
            if (index >= ch->wavetableSize) index = ch->wavetableSize - 1;
            if (index < 0) index = 0;
            return ch->wavetable[index];
        }
        /* Per-cycle wavetable: wraps every 1/frequency seconds */
        double cycleTime = 1.0 / ch->frequency;
        double posInCycle = fmod(t, cycleTime);
        if (posInCycle < 0) posInCycle += cycleTime;
        int index = (int)(posInCycle / cycleTime * ch->wavetableSize);
        if (index >= ch->wavetableSize) index = ch->wavetableSize - 1;
        if (index < 0) index = 0;
        return ch->wavetable[index];
    }
    
    /* Standard sinusoidal equation mode */
    double omega = EQ_TWO_PI * ch->frequency;
    double angle = omega * t + ch->phaseOffset;
    double value = 0.0;
    
    switch (ch->waveType) {
        case EQ_WAVE_SINE:   value = ch->amplitude * sin(angle); break;
        case EQ_WAVE_COSINE: value = ch->amplitude * cos(angle); break;
        case EQ_WAVE_SQUARE: value = ch->amplitude * (sin(angle) >= 0 ? 1.0 : -1.0); break;
        case EQ_WAVE_TRIANGLE: {
            double phase = fmod(angle, EQ_TWO_PI);
            if (phase < 0) phase += EQ_TWO_PI;
            value = ch->amplitude * (phase < EQ_PI ? (2.0 * phase / EQ_PI - 1.0) : (3.0 - 2.0 * phase / EQ_PI));
            break;
        }
    }
    
    /* Apply step response envelope: multiply by (1 + sum of coeff*u(t-T)) */
    if (ch->hasStepResponse) {
        double t_mod = fmod(t, 1.0);
        if (t_mod < 0) t_mod += 1.0;
        double multiplier = 1.0;
        for (int i = 0; i < ch->stepTermCount; i++) {
            if (t_mod >= ch->stepTerms[i].stepTime) {
                multiplier += ch->stepTerms[i].coefficient;
            }
        }
        value *= multiplier;
    }
    
    return (int32_t)(value * ch->scaleFactor);
}

int32_t eq_generate_sample_indexed(const EqChannelData* ch, uint64_t idx, uint32_t rate) {
    return (rate == 0) ? 0 : eq_generate_sample(ch, (double)idx / (double)rate);
}

int eq_generate_all_samples(const EqProcessor* proc, double t, int32_t* samples, int max) {
    if (!proc || !samples) return 0;
    
    int count = (proc->channelCount < max) ? proc->channelCount : max;
    for (int i = 0; i < count; i++) {
        samples[i] = eq_generate_sample(&proc->channels[i], t);
    }
    return count;
}

void eq_generate_9_2le_samples(const EqProcessor* proc, double t, int32_t curr[4], int32_t volt[4]) {
    if (!proc || !curr || !volt) return;
    
    static const char* curr_ids[] = {"Ia", "Ib", "Ic", "In"};
    static const char* volt_ids[] = {"Va", "Vb", "Vc", "Vn"};
    
    for (int i = 0; i < 4; i++) {
        const EqChannelData* ch = eq_get_channel(proc, curr_ids[i]);
        curr[i] = ch ? eq_generate_sample(ch, t) : 0;
    }
    for (int i = 0; i < 4; i++) {
        const EqChannelData* ch = eq_get_channel(proc, volt_ids[i]);
        volt[i] = ch ? eq_generate_sample(ch, t) : 0;
    }
}

/*============================================================================
 * Channel Access
 *============================================================================*/

const EqChannelData* eq_get_channel(const EqProcessor* proc, const char* id) {
    if (!proc || !id) return NULL;
    
    for (int i = 0; i < proc->channelCount; i++) {
        if (strcmp(proc->channels[i].id, id) == 0) return &proc->channels[i];
    }
    return NULL;
}

const EqChannelData* eq_get_channel_by_index(const EqProcessor* proc, int idx) {
    if (!proc || idx < 0 || idx >= proc->channelCount) return NULL;
    return &proc->channels[idx];
}

int eq_get_channel_count(const EqProcessor* proc) {
    return proc ? proc->channelCount : 0;
}

/*============================================================================
 * Debugging
 *============================================================================*/

void eq_print_all(const EqProcessor* proc) {
    if (!proc) return;
    
    printf("\n=== Equation Processor ===\n");
    printf("Frequency: %.0f Hz, Rate: %u\n", proc->defaultFrequency, proc->sampleRate);
    printf("Channels: %d, Errors: %d\n\n", proc->channelCount, proc->parseErrors);
    
    for (int i = 0; i < proc->channelCount; i++) {
        const EqChannelData* ch = &proc->channels[i];
        if (ch->useWavetable) {
            printf("[%d] %s: WAVETABLE%s (%d samples)\n", i, ch->id,
                   ch->fullSecondWavetable ? " (full-second)" : " (per-cycle)",
                   ch->wavetableSize);
        } else if (ch->hasStepResponse) {
            printf("[%d] %s: amp=%.1f, freq=%.0f, phase=%.1f°, STEP(", i, ch->id,
                   ch->amplitude, ch->frequency, ch->phaseOffset * 180.0 / EQ_PI);
            for (int s = 0; s < ch->stepTermCount; s++) {
                printf("%+.2f@%.3fs%s", ch->stepTerms[s].coefficient, ch->stepTerms[s].stepTime,
                       s < ch->stepTermCount - 1 ? " " : "");
            }
            printf(")\n");
        } else {
            printf("[%d] %s: amp=%.1f, freq=%.0f, phase=%.1f°\n",
                   i, ch->id, ch->amplitude, ch->frequency, ch->phaseOffset * 180.0 / EQ_PI);
        }
    }
    printf("==========================\n\n");
}

void eq_get_stats(const EqProcessor* proc, int* parsed, int* errors) {
    if (!proc) return;
    if (parsed) *parsed = proc->channelCount;
    if (errors) *errors = proc->parseErrors;
}

int eq_validate_equation(const char* eq) {
    if (!eq || !eq[0] || strcmp(eq, "0") == 0) return 1;
    if (strncmp(eq, "WT:", 3) == 0 || strncmp(eq, "WTS:", 4) == 0) return 1;
    if (strstr(eq, "u(t-") || strstr(eq, "u(t")) return 1;
    if (find_ci(eq, "sin") || find_ci(eq, "cos") || find_ci(eq, "square") || find_ci(eq, "triangle")) return 1;
    
    char* endptr;
    strtod(eq, &endptr);
    return (*endptr == '\0' || isspace((unsigned char)*endptr));
}

/*============================================================================
 * C++ Class Implementation
 *============================================================================*/

#ifdef __cplusplus

const char* EquationProcessor::s_channelOrder[EQ_MAX_CHANNELS] = {
    "Ia", "Ib", "Ic", "In", "Va", "Vb", "Vc", "Vn",  // IEC 61850-9-2LE (0-7)
    "Ch9", "Ch10", "Ch11", "Ch12", "Ch13", "Ch14",    // IEC 61869-9 extended (8-13)
    "Ch15", "Ch16", "Ch17", "Ch18", "Ch19", "Ch20"    // IEC 61869-9 extended (14-19)
};

EquationProcessor::EquationProcessor(double defaultFreq, uint32_t sampleRate) {
    /* Zero-initialize m_proc before first use to avoid freeing garbage pointers */
    memset(&m_proc, 0, sizeof(EqProcessor));
    eq_processor_init(&m_proc, defaultFreq, sampleRate);
}

int EquationProcessor::loadEquations(const std::string& equations) {
    std::lock_guard<std::mutex> lock(m_mutex);
    return eq_load_equations(&m_proc, equations.c_str());
}

int32_t EquationProcessor::generateSample(const std::string& channelId, double t) const {
    std::lock_guard<std::mutex> lock(m_mutex);
    const EqChannelData* ch = eq_get_channel(&m_proc, channelId.c_str());
    return ch ? eq_generate_sample(ch, t) : 0;
}

void EquationProcessor::generate9_2LESamples(double t, int32_t* samples, int count) const {
    std::lock_guard<std::mutex> lock(m_mutex);
    // Clamp count to valid range
    if (count < 1) count = 1;
    if (count > EQ_MAX_CHANNELS) count = EQ_MAX_CHANNELS;
    
    // Generate samples for all loaded equations
    int eqCount = (count < m_proc.channelCount) ? count : m_proc.channelCount;
    for (int i = 0; i < eqCount; i++) {
        const EqChannelData* ch = &m_proc.channels[i];
        samples[i] = (ch && ch->isValid) ? eq_generate_sample(ch, t) : 0;
    }
    // Fill remaining channels with zero (if channelCount > loaded equations)
    for (int i = eqCount; i < count; i++) {
        samples[i] = 0;
    }
}

bool EquationProcessor::hasChannel(const std::string& channelId) const {
    std::lock_guard<std::mutex> lock(m_mutex);
    return eq_get_channel(&m_proc, channelId.c_str()) != NULL;
}

double EquationProcessor::getAmplitude(const std::string& channelId) const {
    std::lock_guard<std::mutex> lock(m_mutex);
    const EqChannelData* ch = eq_get_channel(&m_proc, channelId.c_str());
    return ch ? ch->amplitude : 0.0;
}

double EquationProcessor::getFrequency(const std::string& channelId) const {
    std::lock_guard<std::mutex> lock(m_mutex);
    const EqChannelData* ch = eq_get_channel(&m_proc, channelId.c_str());
    return ch ? ch->frequency : m_proc.defaultFrequency;
}

double EquationProcessor::getPhaseOffset(const std::string& channelId) const {
    std::lock_guard<std::mutex> lock(m_mutex);
    const EqChannelData* ch = eq_get_channel(&m_proc, channelId.c_str());
    return ch ? ch->phaseOffset : 0.0;
}

int EquationProcessor::getChannelCount() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_proc.channelCount;
}

void EquationProcessor::setSampleRate(uint32_t rate) {
    std::lock_guard<std::mutex> lock(m_mutex);
    m_proc.sampleRate = rate;
}

void EquationProcessor::setDefaultFrequency(double freq) {
    std::lock_guard<std::mutex> lock(m_mutex);
    m_proc.defaultFrequency = freq;
}

void EquationProcessor::reset() {
    std::lock_guard<std::mutex> lock(m_mutex);
    eq_processor_reset(&m_proc);
}

void EquationProcessor::printAll() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    eq_print_all(&m_proc);
}

#endif /* __cplusplus */
