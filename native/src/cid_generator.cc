/**
 * @file cid_generator.cc
 * @brief CID (Configured IED Description) XML file generator
 *
 * Generates IEC 61850 SCL-compliant CID files from PublisherConfig.
 * Uses plain string formatting — no external XML library required.
 */

#include "../include/cid_generator.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <cstdarg>

/* Maximum generated XML size (generous upper bound) */
#define CID_MAX_XML_SIZE 16384

/* Channel descriptor for FCDA generation */
struct ChannelDesc {
    const char *lnClass;  /* "TCTR" or "TVTR" */
    int         lnInst;   /* Logical node instance (1-based within class) */
    const char *doName;   /* "AmpSv" or "VolSv" */
    const char *prefix;   /* "Ia","Ib","Ic","In","Va","Vb","Vc","Vn" */
};

/* IEC 61850-9-2LE standard channel mapping */
static const ChannelDesc g_std_channels[] = {
    { "TCTR", 1, "AmpSv", "Ia" },
    { "TCTR", 2, "AmpSv", "Ib" },
    { "TCTR", 3, "AmpSv", "Ic" },
    { "TCTR", 4, "AmpSv", "In" },
    { "TVTR", 1, "VolSv", "Va" },
    { "TVTR", 2, "VolSv", "Vb" },
    { "TVTR", 3, "VolSv", "Vc" },
    { "TVTR", 4, "VolSv", "Vn" },
};
#define STD_CHANNEL_COUNT 8

/*---------------------------------------------------------------------------
 * Helper: append formatted text to a dynamic buffer
 *---------------------------------------------------------------------------*/
static int buf_append(char *buf, int pos, int capacity, const char *fmt, ...) {
    if (pos < 0 || pos >= capacity) return pos;
    va_list ap;
    va_start(ap, fmt);
    int written = vsnprintf(buf + pos, (size_t)(capacity - pos), fmt, ap);
    va_end(ap);
    if (written < 0) return pos;
    return pos + written;
}

/*---------------------------------------------------------------------------
 * sv_cid_export — main entry point
 *---------------------------------------------------------------------------*/
int sv_cid_export(const PublisherConfig *config, const char *output_path) {
    if (!config || !output_path) return -1;

    char *xml = (char *)malloc(CID_MAX_XML_SIZE);
    if (!xml) return -1;

    int pos = 0;
    const int cap = CID_MAX_XML_SIZE;

    /* Format MAC addresses as dash-separated hex */
    char dstMAC_str[20];
    snprintf(dstMAC_str, sizeof(dstMAC_str), "%02X-%02X-%02X-%02X-%02X-%02X",
             config->dstMAC[0], config->dstMAC[1], config->dstMAC[2],
             config->dstMAC[3], config->dstMAC[4], config->dstMAC[5]);

    /* Format AppID as hex */
    char appID_str[8];
    snprintf(appID_str, sizeof(appID_str), "%04X", config->appID);

    /* smpRate = samples per cycle */
    int smpRate = 0;
    if (config->frequency > 0.0)
        smpRate = (int)(config->sampleRate / (uint64_t)config->frequency);

    int channelCount = config->channelCount;
    if (channelCount < 1) channelCount = 8;
    if (channelCount > 20) channelCount = 20;

    /* ── XML Declaration & SCL root ── */
    pos = buf_append(xml, pos, cap,
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
        "<SCL xmlns=\"http://www.iec.ch/61850/2003/SCL\" version=\"2007\" revision=\"B\">\n"
        "  <Header id=\"%s\" version=\"1.0\" revision=\"1\"/>\n"
        "\n",
        config->svID);

    /* ── Communication ── */
    pos = buf_append(xml, pos, cap,
        "  <Communication>\n"
        "    <SubNetwork name=\"SV_Net\" type=\"8-MMS\">\n"
        "      <ConnectedAP iedName=\"%s\" apName=\"S1\">\n"
        "        <SMV ldInst=\"MU\" cbName=\"MSVCB01\">\n"
        "          <Address>\n"
        "            <P type=\"MAC-Address\">%s</P>\n"
        "            <P type=\"APPID\">%s</P>\n"
        "            <P type=\"VLAN-ID\">%03X</P>\n"
        "            <P type=\"VLAN-PRIORITY\">%d</P>\n"
        "          </Address>\n"
        "        </SMV>\n"
        "      </ConnectedAP>\n"
        "    </SubNetwork>\n"
        "  </Communication>\n"
        "\n",
        config->svID, dstMAC_str, appID_str,
        config->vlanID, config->vlanPriority);

    /* ── IED ── */
    pos = buf_append(xml, pos, cap,
        "  <IED name=\"%s\" manufacturer=\"Custom\" type=\"MergingUnit\">\n"
        "    <AccessPoint name=\"S1\">\n"
        "      <Server>\n"
        "        <LDevice inst=\"MU\">\n"
        "          <LN0 lnClass=\"LLN0\" inst=\"\" lnType=\"LLN0_Type\">\n"
        "            <DataSet name=\"PhsMeas1\">\n",
        config->svID);

    /* ── FCDA entries ── */
    int tctr_inst = 0;
    int tvtr_inst = 0;
    for (int i = 0; i < channelCount; i++) {
        if (i < STD_CHANNEL_COUNT) {
            /* Standard 9-2LE channels */
            const ChannelDesc *ch = &g_std_channels[i];
            pos = buf_append(xml, pos, cap,
                "              <FCDA ldInst=\"MU\" lnClass=\"%s\" lnInst=\"%d\""
                " doName=\"%s\" daName=\"instMag.i\" fc=\"MX\"/>\n",
                ch->lnClass, ch->lnInst, ch->doName);
            /* Track highest instance per class */
            if (strcmp(ch->lnClass, "TCTR") == 0 && ch->lnInst > tctr_inst)
                tctr_inst = ch->lnInst;
            if (strcmp(ch->lnClass, "TVTR") == 0 && ch->lnInst > tvtr_inst)
                tvtr_inst = ch->lnInst;
        } else {
            /* Extra channels beyond 8: use configured type, fallback to current */
            int isCurrent = (config->channelTypes[i] == 0); /* 0=current, 1=voltage */
            const char *lnClass = isCurrent ? "TCTR" : "TVTR";
            const char *doName  = isCurrent ? "AmpSv" : "VolSv";
            int inst = isCurrent ? ++tctr_inst : ++tvtr_inst;
            pos = buf_append(xml, pos, cap,
                "              <FCDA ldInst=\"MU\" lnClass=\"%s\" lnInst=\"%d\""
                " doName=\"%s\" daName=\"instMag.i\" fc=\"MX\"/>\n",
                lnClass, inst, doName);
        }
    }

    /* ── SampledValueControl ── */
    pos = buf_append(xml, pos, cap,
        "            </DataSet>\n"
        "            <SampledValueControl name=\"MSVCB01\" smvID=\"%s\"\n"
        "                                  smpRate=\"%d\"\n"
        "                                  nofASDU=\"%d\"\n"
        "                                  confRev=\"%u\"\n"
        "                                  multicast=\"true\"\n"
        "                                  datSet=\"PhsMeas1\">\n"
        "              <SmvOpts sampleRate=\"true\" refreshTime=\"true\" sampleSynchronized=\"true\"/>\n"
        "            </SampledValueControl>\n"
        "          </LN0>\n"
        "\n",
        config->svID, smpRate, config->asduCount, config->confRev);

    /* ── Logical node declarations ── */
    /* Count how many TCTR and TVTR we actually used */
    int tctr_max = 0;
    int tvtr_max = 0;
    for (int i = 0; i < channelCount && i < STD_CHANNEL_COUNT; i++) {
        if (i < 4) tctr_max = g_std_channels[i].lnInst;
        else       tvtr_max = g_std_channels[i].lnInst;
    }

    /* Standard TCTR nodes */
    const char *tctr_prefixes[] = { "Ia", "Ib", "Ic", "In" };
    for (int i = 0; i < tctr_max && i < 4; i++) {
        pos = buf_append(xml, pos, cap,
            "          <LN lnClass=\"TCTR\" inst=\"%d\" lnType=\"TCTR_Type\" prefix=\"%s\"/>\n",
            i + 1, tctr_prefixes[i]);
    }

    /* Standard TVTR nodes */
    const char *tvtr_prefixes[] = { "Va", "Vb", "Vc", "Vn" };
    for (int i = 0; i < tvtr_max && i < 4; i++) {
        pos = buf_append(xml, pos, cap,
            "          <LN lnClass=\"TVTR\" inst=\"%d\" lnType=\"TVTR_Type\" prefix=\"%s\"/>\n",
            i + 1, tvtr_prefixes[i]);
    }

    /* Extra LN nodes for channels beyond 8 — use configured types */
    int extra_tctr = tctr_max;  /* continue from last standard TCTR instance */
    int extra_tvtr = tvtr_max;  /* continue from last standard TVTR instance */
    for (int i = STD_CHANNEL_COUNT; i < channelCount; i++) {
        int isCurrent = (config->channelTypes[i] == 0); /* 0=current, 1=voltage */
        const char *lnClass = isCurrent ? "TCTR" : "TVTR";
        const char *lnType  = isCurrent ? "TCTR_Type" : "TVTR_Type";
        int inst = isCurrent ? ++extra_tctr : ++extra_tvtr;
        char prefix[8];
        snprintf(prefix, sizeof(prefix), "Ch%d", i);
        pos = buf_append(xml, pos, cap,
            "          <LN lnClass=\"%s\" inst=\"%d\" lnType=\"%s\" prefix=\"%s\"/>\n",
            lnClass, inst, lnType, prefix);
    }

    /* ── Close IED ── */
    pos = buf_append(xml, pos, cap,
        "        </LDevice>\n"
        "      </Server>\n"
        "    </AccessPoint>\n"
        "  </IED>\n"
        "\n");

    /* ── DataTypeTemplates ── */
    pos = buf_append(xml, pos, cap,
        "  <DataTypeTemplates>\n"
        "    <LNodeType id=\"LLN0_Type\" lnClass=\"LLN0\"/>\n"
        "    <LNodeType id=\"TCTR_Type\" lnClass=\"TCTR\">\n"
        "      <DO name=\"AmpSv\" type=\"SAV_Type\"/>\n"
        "    </LNodeType>\n"
        "    <LNodeType id=\"TVTR_Type\" lnClass=\"TVTR\">\n"
        "      <DO name=\"VolSv\" type=\"SAV_Type\"/>\n"
        "    </LNodeType>\n"
        "    <DOType id=\"SAV_Type\" cdc=\"SAV\">\n"
        "      <DA name=\"instMag\" bType=\"Struct\" type=\"AnalogueValue_Type\" fc=\"MX\"/>\n"
        "      <DA name=\"q\" bType=\"Quality\" fc=\"MX\"/>\n"
        "    </DOType>\n"
        "    <DAType id=\"AnalogueValue_Type\">\n"
        "      <BDA name=\"i\" bType=\"INT32\"/>\n"
        "    </DAType>\n"
        "  </DataTypeTemplates>\n"
        "</SCL>\n");

    /* ── Write file ── */
    if (pos <= 0 || pos >= cap) {
        free(xml);
        return -1;
    }

    FILE *fp = fopen(output_path, "w");
    if (!fp) {
        free(xml);
        return -1;
    }

    size_t written = fwrite(xml, 1, (size_t)pos, fp);
    fclose(fp);
    free(xml);

    return (written == (size_t)pos) ? 0 : -1;
}
