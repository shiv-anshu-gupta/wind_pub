## What to build

Add CID (Configured IED Description) file export to the SV publisher.
CID is an XML file following IEC 61850 SCL (System Configuration Language) schema.
It describes what the publisher sends — so any subscriber can import it and 
auto-configure itself.

## What info goes in the CID

All info is already in PublisherConfig struct (sv_publisher_instance.h):

  svID            → SMV control block svID
  appID           → SMV control block appID  
  confRev         → SMV control block confRev
  smpSynch        → SmpSynch value
  srcMAC[6]       → Communication/PhyConn source MAC
  dstMAC[6]       → Communication/ConnectedAP/SMV multicast address
  vlanPriority    → Communication/ConnectedAP/SMV VLAN priority
  vlanID          → Communication/ConnectedAP/SMV VLAN ID
  sampleRate      → SampledValueControl smpRate (samples per cycle = sampleRate/frequency)
  frequency       → Nominal frequency (50 or 60 Hz)
  asduCount       → SampledValueControl nofASDU
  channelCount    → Number of FCDA entries in DataSet (typically 8)

Channel names follow IEC 61850-9-2LE standard order:
  ch0=Ia, ch1=Ib, ch2=Ic, ch3=In (TCTR — current transformers)
  ch4=Va, ch5=Vb, ch6=Vc, ch7=Vn (TVTR — voltage transformers)
  Channels 0-3 use logical node class TCTR (Current Transformer)
  Channels 4-7 use logical node class TVTR (Voltage Transformer)

## IEC 61850 CID XML structure to generate

The CID file must follow this structure:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<SCL xmlns="http://www.iec.ch/61850/2003/SCL" version="2007" revision="B">
  <Header id="{svID}" version="1.0" revision="1"/>
  
  <Communication>
    <SubNetwork name="SV_Net" type="8-MMS">
      <ConnectedAP iedName="{svID}" apName="S1">
        <SMV ldInst="MU" cbName="MSVCB01">
          <Address>
            <P type="MAC-Address">{dstMAC as 01-0C-CD-xx-xx-xx}</P>
            <P type="APPID">{appID as hex 4000}</P>
            <P type="VLAN-ID">{vlanID}</P>
            <P type="VLAN-PRIORITY">{vlanPriority}</P>
          </Address>
        </SMV>
      </ConnectedAP>
    </SubNetwork>
  </Communication>

  <IED name="{svID}" manufacturer="Custom" type="MergingUnit">
    <AccessPoint name="S1">
      <Server>
        <LDevice inst="MU">
          <LN0 lnClass="LLN0" inst="" lnType="LLN0_Type">
            <DataSet name="PhsMeas1">
              <!-- One FCDA per channel -->
              <FCDA ldInst="MU" lnClass="TCTR" lnInst="1" doName="AmpSv" daName="instMag.i" fc="MX"/>
              <FCDA ldInst="MU" lnClass="TCTR" lnInst="2" doName="AmpSv" daName="instMag.i" fc="MX"/>
              <FCDA ldInst="MU" lnClass="TCTR" lnInst="3" doName="AmpSv" daName="instMag.i" fc="MX"/>
              <FCDA ldInst="MU" lnClass="TCTR" lnInst="4" doName="AmpSv" daName="instMag.i" fc="MX"/>
              <FCDA ldInst="MU" lnClass="TVTR" lnInst="1" doName="VolSv" daName="instMag.i" fc="MX"/>
              <FCDA ldInst="MU" lnClass="TVTR" lnInst="2" doName="VolSv" daName="instMag.i" fc="MX"/>
              <FCDA ldInst="MU" lnClass="TVTR" lnInst="3" doName="VolSv" daName="instMag.i" fc="MX"/>
              <FCDA ldInst="MU" lnClass="TVTR" lnInst="4" doName="VolSv" daName="instMag.i" fc="MX"/>
            </DataSet>
            <SampledValueControl name="MSVCB01" smvID="{svID}" 
                                  smpRate="{sampleRate/frequency}" 
                                  nofASDU="{asduCount}" 
                                  confRev="{confRev}"
                                  multicast="true"
                                  datSet="PhsMeas1">
              <SmvOpts sampleRate="true" refreshTime="true" sampleSynchronized="true"/>
            </SampledValueControl>
          </LN0>
          
          <!-- Current transformer logical nodes -->
          <LN lnClass="TCTR" inst="1" lnType="TCTR_Type" prefix="Ia"/>
          <LN lnClass="TCTR" inst="2" lnType="TCTR_Type" prefix="Ib"/>
          <LN lnClass="TCTR" inst="3" lnType="TCTR_Type" prefix="Ic"/>
          <LN lnClass="TCTR" inst="4" lnType="TCTR_Type" prefix="In"/>
          
          <!-- Voltage transformer logical nodes -->
          <LN lnClass="TVTR" inst="1" lnType="TVTR_Type" prefix="Va"/>
          <LN lnClass="TVTR" inst="2" lnType="TVTR_Type" prefix="Vb"/>
          <LN lnClass="TVTR" inst="3" lnType="TVTR_Type" prefix="Vc"/>
          <LN lnClass="TVTR" inst="4" lnType="TVTR_Type" prefix="Vn"/>
        </LDevice>
      </Server>
    </AccessPoint>
  </IED>
  
  <DataTypeTemplates>
    <LNodeType id="LLN0_Type" lnClass="LLN0"/>
    <LNodeType id="TCTR_Type" lnClass="TCTR">
      <DO name="AmpSv" type="SAV_Type"/>
    </LNodeType>
    <LNodeType id="TVTR_Type" lnClass="TVTR">
      <DO name="VolSv" type="SAV_Type"/>
    </LNodeType>
    <DOType id="SAV_Type" cdc="SAV">
      <DA name="instMag" bType="Struct" type="AnalogueValue_Type" fc="MX"/>
      <DA name="q" bType="Quality" fc="MX"/>
    </DOType>
    <DAType id="AnalogueValue_Type">
      <BDA name="i" bType="INT32"/>
    </DAType>
  </DataTypeTemplates>
</SCL>
```

## What to create

### NEW FILE: native/src/cid_generator.cc
### NEW FILE: native/include/cid_generator.h

Create a function:
  int sv_cid_export(const PublisherConfig *config, const char *output_path);

This function:
  1. Takes the PublisherConfig
  2. Generates the CID XML string using the template above
  3. Fills in all values from config (svID, appID, MAC addresses, etc.)
  4. Format MAC as "01-0C-CD-04-00-01" (dash-separated hex)
  5. Format AppID as hex (e.g. "4000")
  6. smpRate = config->sampleRate / config->frequency (samples per cycle)
  7. Generate correct number of FCDA entries based on channelCount
     (first 4 = TCTR current, next 4 = TVTR voltage, remaining = generic)
  8. Write to output_path as UTF-8 XML file
  9. Return 0 on success, -1 on error

No external XML library needed — the structure is fixed, just use snprintf/string 
concatenation to build the XML. Keep it simple.

### MODIFY: native/src/sv_native_refactored.cc

Add a command-line option or auto-export:
  After config is parsed and before publishing starts,
  call sv_cid_export(&config, "{svID}.cid") to generate the CID file.
  Print: "[cid] Exported CID to {svID}.cid"

## UCAIUG conformance notes

The CID must:
  - Use SCL namespace "http://www.iec.ch/61850/2003/SCL"
  - Have version="2007" revision="B" 
  - Include DataTypeTemplates section with proper type hierarchy
  - Use correct lnClass values: TCTR for current, TVTR for voltage
  - Use correct doName values: AmpSv for current, VolSv for voltage
  - Include SmvOpts with sampleRate, refreshTime, sampleSynchronized

## Do NOT change any existing publisher logic — only ADD the CID export.











this is very critical task so you have to be very carefully on updating so the working will not affect