/**
 * @file cid_generator.h
 * @brief CID (Configured IED Description) file export for SV publisher
 *
 * Generates IEC 61850 SCL-compliant CID XML files describing
 * Sampled Values publisher configuration for subscriber auto-configuration.
 */

#ifndef CID_GENERATOR_H
#define CID_GENERATOR_H

#include "sv_publisher_instance.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Export a CID file from publisher configuration.
 *
 * Generates an IEC 61850 SCL XML file containing:
 *   - Communication section (SMV multicast address, VLAN, AppID)
 *   - IED section (DataSet with FCDA entries, SampledValueControl)
 *   - DataTypeTemplates (TCTR/TVTR type hierarchy)
 *
 * @param config      Pointer to the publisher configuration
 * @param output_path File path to write the CID XML to (UTF-8)
 * @return 0 on success, -1 on error
 */
int sv_cid_export(const PublisherConfig *config, const char *output_path);

#ifdef __cplusplus
}
#endif

#endif /* CID_GENERATOR_H */
