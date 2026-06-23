/**
 * @file cidExporter.js
 * @description Generate IEC 61850 CID (Configured IED Description) XML
 *              from the current publisher configuration.
 *
 * CID files are SCL-compliant XML documents that describe the complete
 * configuration of a publisher (MU - Merging Unit). They can be imported
 * into subscriber applications for auto-configuration.
 *
 * Usage:
 *   import { exportCID } from './utils/cidExporter.js';
 *   exportCID(store);  // downloads MU01.cid
 *
 * @author SV-PUB Team
 * @date 2026
 */

/**
 * Map channel ID to IEC 61850 data object name.
 * Standard channels use canonical IEC 61850 names (phV, A, etc.)
 * Custom channels are prefixed with ch_
 * @param {Object} ch - Channel object with id property
 * @returns {string} IEC 61850 data object name
 */
function channelToDoName(ch) {
  const map = {
    // Voltages
    Va: 'phV.phsA', Vb: 'phV.phsB', Vc: 'phV.phsC', Vn: 'phV.neut',
    // Currents
    Ia: 'A.phsA',   Ib: 'A.phsB',   Ic: 'A.phsC',   In: 'A.neut',
  };
  return map[ch.id] || `ch_${ch.id}`;
}

/**
 * Escape XML special characters
 * @param {*} str - Value to escape
 * @returns {string} XML-safe string
 */
function xmlEsc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate CID XML string from publisher config and channels.
 * 
 * Creates a complete IEC 61850 SCL-compliant CID file with:
 * - Header: File metadata and publisher identification
 * - Communication: Network configuration (MAC, APPID, VLAN)
 * - IED: Device description with data objects and SV control
 * - DataTypeTemplates: Type definitions for all channels
 * - Private: Custom extension with full publisher configuration
 *
 * @param {Object} config - store.getConfig() output with:
 *   - standard, frequency, samplesPerCycle, sampleRate
 *   - noASDU, srcMAC, dstMAC, vlanID, vlanPriority
 *   - svID, appID, confRev, smpSynch, selectedChannels
 * @param {Array} channels - store.getChannels() output with:
 *   - id, label, type, unit, scaleFactor, equation properties
 * @returns {string} Complete CID XML document
 */
export function generateCIDXml(config, channels) {
  const svID = xmlEsc(config.svID || 'MU01');
  const appIDHex = '0x' + (config.appID || 0x4000).toString(16).toUpperCase().padStart(4, '0');
  const confRev = config.confRev || 1;
  const spc = config.samplesPerCycle || 80;
  const noASDU = config.noASDU || 1;
  const dstMAC = config.dstMAC || '01:0C:CD:04:00:00';
  const srcMAC = config.srcMAC || '00:00:00:00:00:01';
  const vlanID = config.vlanID || 0;
  const vlanPri = config.vlanPriority || 4;
  const freq = config.frequency || 60;
  const rate = config.sampleRate || (spc * freq);
  const standard = xmlEsc(config.standard || '9-2LE');

  // Build FCDA (Functional Constrained Data Attribute) entries for DataSet
  // These reference the channels that will be transmitted in the SV stream
  const selectedChs = config.selectedChannels || channels.map(c => c.id);
  const fcdas = selectedChs.map(id => {
    const ch = channels.find(c => c.id === id);
    const dn = ch ? channelToDoName(ch) : `ch_${id}`;
    return `              <FCDA ldInst="MU01" lnClass="MMXU" lnInst="1" doName="${dn}" daName="instMag.f" fc="MX"/>`;
  }).join('\n');

  // Build DO (Data Object) entries for LNodeType
  // Defines all available data objects in the MMXU logical node
  const dos = channels.map(ch =>
    `      <DO name="${channelToDoName(ch)}" type="MV_${ch.id}"/>`
  ).join('\n');

  // Build DOType (Data Object Type) + DAType (Data Attribute Type) definitions
  // Each channel has its own MV (measured value) type with magnitude, quality, timestamp
  const types = channels.map(ch => `
    <DOType id="MV_${ch.id}" cdc="MV">
      <DA name="instMag" bType="Struct" type="AV_${ch.id}" fc="MX"/>
      <DA name="q" bType="Quality" fc="MX"/>
      <DA name="t" bType="Timestamp" fc="MX"/>
      <DA name="d" bType="VisString255" fc="DC" val="${xmlEsc(ch.label || ch.id)}"/>
      <DA name="units" bType="VisString255" fc="CF" val="${xmlEsc(ch.unit || '')}"/>
      <DA name="sVC" bType="Struct" type="SV_${ch.id}" fc="CF"/>
    </DOType>
    <DAType id="AV_${ch.id}">
      <BDA name="f" bType="FLOAT32"/>
    </DAType>
    <DAType id="SV_${ch.id}">
      <BDA name="scaleFactor" bType="FLOAT32" val="${ch.scaleFactor || 1}"/>
      <BDA name="offset" bType="FLOAT32" val="0"/>
    </DAType>`).join('\n');

  // Build Private extension Channel entries
  // PowerEureka custom extension for full publisher configuration
  const privChs = channels.map((ch, i) =>
    `      <Channel index="${i}" id="${xmlEsc(ch.id)}" label="${xmlEsc(ch.label || ch.id)}" type="${xmlEsc(ch.type || 'custom')}" phase="${xmlEsc(ch.phase || '')}" unit="${xmlEsc(ch.unit || '')}" scaleFactor="${ch.scaleFactor || 1}" equation="${xmlEsc(ch.equation || '0')}"/>`
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<SCL xmlns="http://www.iec.ch/61850/2003/SCL">

  <Header id="${svID}" version="1.0" revision="${confRev}"
          toolID="PowerEureka SV Publisher" nameStructure="IEDName"/>

  <Communication>
    <SubNetwork name="SV_Network" type="8-MMS">
      <ConnectedAP iedName="${svID}" apName="S1">
        <SMV ldInst="MU01" cbName="MSVCB01">
          <Address>
            <P type="MAC-Address">${dstMAC}</P>
            <P type="APPID">${appIDHex}</P>
            <P type="VLAN-ID">${vlanID}</P>
            <P type="VLAN-PRIORITY">${vlanPri}</P>
          </Address>
        </SMV>
      </ConnectedAP>
    </SubNetwork>
  </Communication>

  <IED name="${svID}" manufacturer="PowerEureka" type="MU"
       configVersion="${confRev}">
    <AccessPoint name="S1">
      <Server>
        <LDevice inst="MU01">
          <LN0 lnClass="LLN0" inst="" lnType="LLN0_Type">
            <DataSet name="dsMSV">
${fcdas}
            </DataSet>
            <SampledValueControl name="MSVCB01" datSet="dsMSV"
              smvID="${svID}" confRev="${confRev}"
              smpRate="${spc}" nofASDU="${noASDU}"
              smpMod="SmpPerPeriod" multicast="true">
              <SmvOpts sampleRate="true" sampleSynchronized="true"
                       timestamp="true" dataSet="true"/>
            </SampledValueControl>
          </LN0>
          <LN lnClass="MMXU" inst="1" lnType="MMXU_MU01"/>
        </LDevice>
      </Server>
    </AccessPoint>
  </IED>

  <DataTypeTemplates>
    <LNodeType id="MMXU_MU01" lnClass="MMXU">
${dos}
    </LNodeType>
${types}
    <LNodeType id="LLN0_Type" lnClass="LLN0">
      <DO name="Mod" type="INC"/>
      <DO name="Beh" type="INS"/>
    </LNodeType>
  </DataTypeTemplates>

  <Private type="PowerEureka-SV-Config">
    <PublisherConfig
      standard="${standard}" frequency="${freq}"
      samplesPerCycle="${spc}" sampleRate="${rate}"
      noASDU="${noASDU}" svID="${svID}"
      appID="${config.appID || 0x4000}" confRev="${confRev}"
      smpSynch="${config.smpSynch || 2}"
      srcMAC="${srcMAC}" dstMAC="${dstMAC}"
      vlanID="${vlanID}" vlanPriority="${vlanPri}"/>
    <Channels>
${privChs}
    </Channels>
  </Private>

</SCL>`;
}

/**
 * Generate and download CID file.
 * Creates an XML blob and triggers browser download with filename = svID.cid
 * @param {Object} store - Publisher store instance
 */
export function exportCID(store) {
  // Store exposes get('config') / getChannels() (there is no getConfig()).
  const config = store.get('config');
  const channels = store.getChannels();
  const xml = generateCIDXml(config, channels);

  const blob = new Blob([xml], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${config.svID || 'MU01'}.cid`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  console.log(`[cidExporter] ✅ CID file exported: ${config.svID || 'MU01'}.cid`);
}
