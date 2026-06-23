<<<<<<< Updated upstream
TASK: Make FrameStructure MU-aware so it shows the selected MU's header and channels
Context
This is the SV Publisher (Tauri + vanilla JS) application. Manager feedback: "For each MU, there was no window to see to show the header and channel names & details. When you select the MU, you should be able to see the configuration — this window can be hidden to the sidebar."
The cleanest solution is to reuse the existing Frame Structure sidebar instead of building a new one. Frame Structure already renders everything the manager asked for (svID, AppID, confRev, smpSynch, MACs, VLAN, per-channel seqData tree with byte offsets and hex) — but today it reads from the global config only. It doesn't know which MU was clicked in Multi-Publisher. Fix that link.
Files involved
FileRoleweb/js/components/MultiPublisher.jsOwns the MU cards list. Add selection state + click-to-select.web/js/components/FrameViewer.jsRenders the frame tree. Make it read the active MU's config when one is selected.web/js/plugins/frameSidebar.jsAlready exports openFrameSidebar(). Just import and call.web/style.cssAdd .mp-pub--selected highlight.web/js/store/index.jsAdd an ui.activeMu slice (object or null).
Requirements

Selection state in MultiPublisher

Add let _selectedLocalId = null; to module state.
Make the entire .mp-pub-header (the row with the badges) clickable to select that MU. Do NOT hijack clicks on the existing ▼ expand button or ✕ delete button — they keep their current behaviour.
On click: set _selectedLocalId = pub.localId, call store.set('ui.activeMu', { localId, svId, appId, confRev, smpSynch, channelCount }), re-render the list so the highlight updates.
If the selected MU is deleted, clear selection: _selectedLocalId = null, store.set('ui.activeMu', null).
If editable fields (svId, appId, confRev, channelCount) of the selected MU change, push the update into store.set('ui.activeMu', ...) too so FrameStructure stays live.
=======
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
>>>>>>> Stashed changes

Channel names follow IEC 61850-9-2LE standard order:
  ch0=Ia, ch1=Ib, ch2=Ic, ch3=In (TCTR — current transformers)
  ch4=Va, ch5=Vb, ch6=Vc, ch7=Vn (TVTR — voltage transformers)
  Channels 0-3 use logical node class TCTR (Current Transformer)
  Channels 4-7 use logical node class TVTR (Voltage Transformer)

<<<<<<< Updated upstream
Visual highlight

In render(), add class mp-pub--selected to the card whose localId === _selectedLocalId.
In style.css, add a rule: .mp-pub--selected { border-left: 3px solid var(--primary); background: var(--gray-50); } (match your existing token names — adjust if different).


Auto-open sidebar on first click

Import openFrameSidebar from ../plugins/frameSidebar.js.
Track a module-level flag _autoOpenedOnce = false. On the first MU click of the session, call openFrameSidebar() and set the flag. Subsequent clicks do NOT auto-open — respect the user's open/closed choice.


Make FrameViewer MU-aware

In getCurrentConfig() (around line 1953 in FrameViewer.js): read const activeMu = store.get('ui.activeMu'); first. If present, override svID, appID, confRev, smpSynch with the MU's values. If absent, keep the existing global-config behaviour (Single-Stream mode must still work unchanged).
In buildFrameTree(config): if an activeMu is set, slice channels with selectedChannels.slice(0, activeMu.channelCount) so a 4-channel MU renders 4 channels in seqData, not the full global list. Recalculate channelCount, seqDataLen, asduContentLen, and downstream length fields from the sliced array.
Subscribe to ui.activeMu changes in the store and trigger a re-render of the tree when it changes — same pattern FrameViewer already uses for other store subscriptions.


Header breadcrumb in FrameViewer

In getTemplate(), under the <h2>Frame Structure</h2>, add a small breadcrumb element: <div class="frame-breadcrumb" id="frameBreadcrumb"></div>.
On render, populate it:

If ui.activeMu is set: Inspecting: ${svId} (0x${appId.toString(16).toUpperCase().padStart(4,'0')}, ${channelCount}ch)
If null: Single Stream (or hide the breadcrumb entirely — your call, but keep it consistent).


Style it small and muted — it's a status line, not a heading.


Empty-state guard

If the app is in Multi-Stream mode (store.get('publishMode') === 'multi' or however it's tracked) AND ui.activeMu is null, replace the tree body with a friendly hint: "Click an MU in the Multi-Publisher panel to inspect its frame." Keep the sidebar open so the hint is visible.
In Single-Stream mode, behaviour is unchanged from today.



Constraints

Do not break Single-Stream mode. When no MU is selected (or the app is in Single-Stream), FrameViewer must render exactly as it does today.
Do not duplicate render logic. Single source of truth: FrameViewer's existing buildFrameTree + render path, with a config object that's either global or MU-derived.
Do not break the existing FrameViewer features: edit mode, hex panel, expand/collapse, channel drag-reorder, ASDU selector. All must continue to work.
Vanilla JS, no new dependencies. Match the existing module style (private state with _ prefix, _el for DOM refs, store import path, showToast for user feedback).
Selection state is UI-only — do NOT persist _selectedLocalId to localStorage or to the publisher config. It resets when the app reloads.

Out of scope

No new sidebar, no new component file, no MU Inspector.
Don't change CID export, don't change the publisher start/stop flow, don't change backend FFI.
Don't add per-MU channel editing in FrameViewer — channels remain shared from Data Source. FrameViewer in MU-mode is read-only for channel composition (the existing edit mode for header bytes / channel reorder can stay; just don't add anything new).

One question to confirm with the user before coding
Should clicking an MU card also expand the card (current ▼ behaviour) or just select it? Today expand and select would be separate actions. Pick one:

Click row = select only; ▼ button = expand inline editor (two separate gestures)
Click row = select and expand; ▼ becomes redundant (simpler, but changes existing UX)

Default to the first option unless told otherwise — it preserves current behaviour.
Deliverable
Diffs (or full file replacements) for the five files listed. Briefly explain any deviation from this spec before making it.

Paste that into the new session. If they ask clarifying questions about the store schema or existing FrameViewer internals, the answers are in MultiPublisher.js lines 60–230 and FrameViewer.js lines 1953–1975 (the getCurrentConfig block)
=======
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
>>>>>>> Stashed changes
