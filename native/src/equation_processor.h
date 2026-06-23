/**
 * @file equation_processor.h
 * @brief Equation Processing for SV Publisher
 * 
 * Parses waveform equations and generates samples for IEC 61850-9-2LE.
 * 
 * Supported equation format:
 *   "100 * sin(2 * PI * 50 * t)"           -> amp=100, freq=50 Hz
 *   "325 * sin(2 * PI * 50 * t - 2*PI/3)"  -> amp=325, freq=50 Hz, phase=-120°
 *   "0"                                     -> zero signal
 */

#ifndef EQUATION_PROCESSOR_H
#define EQUATION_PROCESSOR_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/*============================================================================
 * Constants
 *============================================================================*/

#define EQ_MAX_CHANNELS     20   // IEC 61869-9 supports up to 20 channels
#define EQ_MAX_EQUATION_LEN 512
#define EQ_MAX_ID_LEN       32
#define EQ_MAX_STEP_TERMS   8    // Max u(t-T) step terms per channel
#define EQ_PI               3.14159265358979323846
#define EQ_TWO_PI           (2.0 * EQ_PI)

/*============================================================================
 * Data Types
 *============================================================================*/

typedef enum {
    EQ_WAVE_SINE = 0,
    EQ_WAVE_COSINE = 1,
    EQ_WAVE_SQUARE = 2,
    EQ_WAVE_TRIANGLE = 3
} EqWaveformType;

/**
 * A single u(t-T) step term: coefficient * u(t - stepTime)
 * e.g. "-0.85*u(t-0.5)" → { coefficient = -0.85, stepTime = 0.5 }
 */
typedef struct {
    double coefficient;   /* Multiplier applied when t >= stepTime */
    double stepTime;      /* Time threshold (seconds within 1s frame) */
} EqStepTerm;

typedef struct {
    char id[EQ_MAX_ID_LEN];
    char equation[EQ_MAX_EQUATION_LEN];
    double amplitude;
    double frequency;
    double phaseOffset;
    double scaleFactor;
    int isZero;
    int isValid;
    EqWaveformType waveType;
    /* Wavetable support for computed/derived channels */
    int32_t* wavetable;       /* Pre-computed sample values for one cycle */
    int wavetableSize;         /* Number of samples in wavetable */
    int useWavetable;          /* 1 = use wavetable instead of equation */
    int fullSecondWavetable;   /* 1 = wavetable covers full second (no cycle wrap) */
    /* Step response support: u(t-T) Heaviside step functions */
    EqStepTerm stepTerms[EQ_MAX_STEP_TERMS];
    int stepTermCount;         /* Number of active step terms */
    int hasStepResponse;       /* 1 = multiply base sine by step envelope */
} EqChannelData;

typedef struct {
    EqChannelData channels[EQ_MAX_CHANNELS];
    int channelCount;
    double defaultFrequency;
    uint32_t sampleRate;
    uint64_t samplesGenerated;
    int parseErrors;
} EqProcessor;

/*============================================================================
 * API Functions
 *============================================================================*/

/* Initialize/Reset */
int eq_processor_init(EqProcessor* proc, double defaultFreq, uint32_t sampleRate);
void eq_processor_reset(EqProcessor* proc);

/* Load equations from pipe-delimited string: "Ia:equation|Ib:equation|..." */
int eq_load_equations(EqProcessor* proc, const char* equations);

/* Parse single equation */
int eq_parse_equation(const char* equation, EqChannelData* channel, double defaultFreq);

/* Parse wavetable from string format "WT:count:v1,v2,v3,..." */
int eq_parse_wavetable(const char* wtString, EqChannelData* channel, double defaultFreq);

/* Free wavetable memory for a single channel */
void eq_free_channel_wavetable(EqChannelData* channel);

/* Free all wavetable memory in processor */
void eq_free_all_wavetables(EqProcessor* proc);

/* Set equation for specific channel */
int eq_set_channel_equation(EqProcessor* proc, const char* channelId, const char* equation);

/* Sample generation */
int32_t eq_generate_sample(const EqChannelData* channel, double t);
int32_t eq_generate_sample_indexed(const EqChannelData* channel, uint64_t sampleIndex, uint32_t sampleRate);
int eq_generate_all_samples(const EqProcessor* proc, double t, int32_t* samples, int maxSamples);
void eq_generate_9_2le_samples(const EqProcessor* proc, double t, int32_t currents[4], int32_t voltages[4]);

/* Channel access */
const EqChannelData* eq_get_channel(const EqProcessor* proc, const char* channelId);
const EqChannelData* eq_get_channel_by_index(const EqProcessor* proc, int index);
int eq_get_channel_count(const EqProcessor* proc);

/* Debugging */
void eq_print_all(const EqProcessor* proc);
void eq_get_stats(const EqProcessor* proc, int* totalParsed, int* parseErrors);
int eq_validate_equation(const char* equation);

#ifdef __cplusplus
}
#endif

/*============================================================================
 * C++ Class Wrapper
 *============================================================================*/

#ifdef __cplusplus
#include <string>
#include <mutex>

class EquationProcessor {
public:
    EquationProcessor(double defaultFreq = 50.0, uint32_t sampleRate = 4800);
    
    /* Load equations from string */
    int loadEquations(const std::string& equations);
    
    /* Generate samples */
    int32_t generateSample(const std::string& channelId, double t) const;
    void generate9_2LESamples(double t, int32_t* samples, int count = 8) const;
    
    /* Channel queries */
    bool hasChannel(const std::string& channelId) const;
    double getAmplitude(const std::string& channelId) const;
    double getFrequency(const std::string& channelId) const;
    double getPhaseOffset(const std::string& channelId) const;
    int getChannelCount() const;
    
    /* Configuration */
    void setSampleRate(uint32_t rate);
    void setDefaultFrequency(double freq);
    void reset();
    void printAll() const;

private:
    mutable std::mutex m_mutex;
    EqProcessor m_proc;
    static const char* s_channelOrder[EQ_MAX_CHANNELS];  // Support up to 20 channels
};

#endif /* __cplusplus */

#endif /* EQUATION_PROCESSOR_H */
