/*  script.js — Fairness-Metric Dashboard
   --------------------------------------
   − Fetches data from Flask
   − Draws centred 3-layer Sankey (GT → Group → Outcome)
   − Colours numerators & denominators per selected metric
*/

/* ========= 0. CONFIG ===================================== */
function getVizHeight(){
  const v = parseFloat(
    getComputedStyle(document.documentElement)
      .getPropertyValue('--viz-height')
  );
  return Number.isFinite(v) ? v : 225;
}

// Gate by Top-K (PCP set SHOW_TOP_ONLY=true somewhere global to enable)
const ALPHA_Q  = 0.10;   // BH-FDR threshold (if you have q_*)
const P_ALPHA  = 0.05;   // fallback if only p-values exist
const SU_MIN   = 0.05;   // minimal effect on SU
const KS_MIN   = 0.20;   // minimal effect on score distribution
N_PERM_PVALUE  = 500;
const EXCLUDE_ALWAYS = new Set();
SHOW_TOP_ONLY = true;

let groupBarsView = "metric-by-group"; 

// Numerator/Denominator coloring for outcome nodes
const NUM_NODE_COLOR   = "#08519c";  // deep blue (numerator)
const DEN_NODE_COLOR   = "#6baed6";  // light blue (denominator)
const OTHER_NODE_COLOR = "#c7c7c7";  // neutral for outcomes not in num/den
const GT_NODE_COLOR    = "#666666";  // GT+ / GT-
// GT hub colors (match PCP point colors for ground truth)
const GT_POS_COLOR = "#487bccff"; // ← replace with your PCP GT+ color
const GT_NEG_COLOR = "#d34e3fff"; // ← replace with your PCP GT− color

// --- Stream selection state (multi-select) ---
window.streamSelections = window.streamSelections || new Map(); // key -> {group, outcome, ids:Set, color}
const MAX_STREAM_ROWS = 400; // cap drawn PCP stream lines so bundles stay readable
const OUTS = new Set(["TP","FP","TN","FN"]);
const outcomeOfLink = d => (d?.target?.name && OUTS.has(d.target.name)) ? d.target.name : null;
const streamKeyFromLink = d => `${d.source?.name}|${d.target?.name}`;

const sankeySvgW = 380;
const sankeySvgH = getVizHeight();
const API_ROOT   = "";                 // same origin
PCP_HIDE = new Set(["PersonalStatusSex"]);

// Universal styled tooltip helper
function createStyledTooltip(className = "styled-tooltip") {
  return d3.select("body").selectAll(`.${className}`).data([0])
    .join("div")
    .attr("class", className)
    .style("position", "absolute")
    .style("background", "rgba(0, 0, 0, 0.85)")
    .style("color", "#fff")
    .style("padding", "8px 12px")
    .style("border-radius", "4px")
    .style("font-size", "12px")
    .style("pointer-events", "none")
    .style("z-index", "10000")
    .style("line-height", "1.4")
    .style("opacity", 0);
}

function showStyledTooltip(tooltip, html, event) {
  tooltip
    .html(html)
    .style("opacity", 1)
    .style("left", (event.pageX + 10) + "px")
    .style("top", (event.pageY - 10) + "px");
}

function hideStyledTooltip(tooltip) {
  tooltip.style("opacity", 0);
}

// Context band options
const CONTEXT_Q_LO = 0.10;
const CONTEXT_Q_HI = 0.90;
const CONTEXT_BAND_OPACITY = 0.20;   // fill opacity
const CONTEXT_BAND_STROKE_OPACITY = 0.45;

window.contextGroupIds = window.contextGroupIds || new Set();  // context bands
window.streamRowIds    = window.streamRowIds    || new Set();  // streams

// === Neutralization State ===
window.NEUTRAL = window.NEUTRAL || { active: false, backup: null, scope: null, features: [] };

/* ========= PALETTE GENERATOR ============================= */
// Which Sankey outcome nodes are toggled on for the PCP
const selectedOutcomes = new Set();
// NEW: Which protected-group nodes from the Sankey are toggled on for the PCP
const selectedGroups = new Set();
// Color palette for groups (enough distinct colors)
const GROUP_COLORS = d3.schemeTableau10;

// Correct / misclassified
const CORRECT_COLOR = "#74a9cf";
const WRONG_COLOR   = "#de2d26";
// Distinct PCP colors per confusion outcome
const OUTCOME_COLORS = Object.freeze({
  TP: "#2ca02c", // green
  FP: "#d62728", // red
  TN: "#1f77b4", // blue
  FN: "#9467bd"  // purple
});
// A big-enough categorical palette and a global ordinal scale for group nodes
const GROUP_BASE_PALETTE = [
  ...d3.schemeTableau10,   // 10
  ...d3.schemeSet3,        // +12 = 22
  ...d3.schemePaired       // +12 = 34
];
let GROUP_COLOR_SCALE = null;

// Fallback palette generator if you ever exceed ~34 groups
function _genPalette(n){
  const out = [];
  for (let i=0;i<n;i++){
    const h = (i * 137.508) % 360;   // low-collision golden-angle walk
    out.push(d3.hsl(h, 0.58, 0.52).formatHex());
  }
  return out;
}

// Small-multiples: which metrics to show (EO shown twice: TPR & FPR)
const MULTI_METRICS = [
  { key: "equal_opportunity",   label: "Equal Opportunity — TPR"        , component: "tpr" },
  { key: "equal_opportunity",   label: "Equal Opportunity — FNR (1−TPR)", component: "fpr" }, // optional alt view
  { key: "predictive_parity",   label: "Predictive Parity — PPV" },
  { key: "predictive_equality", label: "Predictive Equality — FPR" },
  { key: "equalized_odds",      label: "Equalized Odds — TPR"           , component: "tpr" },
  { key: "equalized_odds",      label: "Equalized Odds — FPR"           , component: "fpr" },
  { key: "demographic_parity",  label: "Demographic Parity — Pred+ rate" },
  { key: "treatment_equality",  label: "Treatment Equality — FN/FP" }
];

// PCP data container
window.state = { data: [], numericKeys: [], catKeys: [], _thr: null };
// Which PCP features (axes) are visible. Initialized once after PCP data loads.
window.pcpFeatureWhitelist = window.pcpFeatureWhitelist || null;

// pretty axis labels
function friendly(s){
  return String(s).replace(/_/g, " ")
                  .replace(/\b\w/g, m => m.toUpperCase());
}

// --- Outcome selection helpers ---
function clearStreamsAndGroups() {
  if (window.streamSelections?.size) {
    window.streamSelections.clear();
    if (typeof refreshLinkStyling === 'function') refreshLinkStyling();
  }
  if (selectedGroups?.size) selectedGroups.clear();
  if (window.contextGroupIds?.size) window.contextGroupIds.clear();

  if (typeof window.applyGroupNodeStyles === 'function') window.applyGroupNodeStyles();
}

function toggleOutcomeSelection(name) {
  const OUTS = new Set(["TP","FP","TN","FN"]);
  if (!OUTS.has(name)) return;

  if (selectedOutcomes.has(name)) {
    selectedOutcomes.delete(name);
  } else {
    selectedOutcomes.add(name);
  }

  clearStreamsAndGroups();

  if (typeof window.applyGroupNodeStyles === 'function') window.applyGroupNodeStyles();
  if (typeof updateLinkLegend === 'function') updateLinkLegend();
  
  renderPCP();
  updateFeatureDistribution();  // ADD THIS LINE
}


// Map a row to its confusion-outcome string
function rowOutcome(d){
  const t = +d.true_label, p = +d.prediction;
  if (t === 1 && p === 1) return "TP";
  if (t === 0 && p === 1) return "FP";
  if (t === 0 && p === 0) return "TN";
  if (t === 1 && p === 0) return "FN";
  return null;
}

function assignStreamColors() {
  const entries = Array.from(window.streamSelections.entries()); // [ [key, {group,outcome,ids,color?}], ... ]
  if (!entries.length) return;

  // Generate contrasting colors for multiple selections
  // This allows users to see multiple streams in different colors like in Sankey
  const colors = (window.genContrastingPalette)
    ? window.genContrastingPalette(entries.length)
    : d3.schemeTableau10.slice(0, entries.length);

  // Assign colors deterministically by entry order
  entries.forEach(([key, sel], i) => {
    sel.color = colors[i];
  });

  // Write back
  window.streamSelections = new Map(entries);
}

/* ========= 1. STATE ====================================== */
let currentProtected = ["age"];        // default
let currentMetric    = null;  // No metric selected by default
let currentThr       = 0.5;
let contribScale = null;
let metricScale = null;
let hoverOutcome = null;   // "TP" | "FP" | "TN" | "FN" | null
let hoverGT      = null;  // "GT+" | "GT-" | null
// NEW: axis order for the parallel–coords plot
let pcpOrder = [];
// map outcome node → link field that holds the rate
const rateAttr = { TP: "rate_tpr", FP: "rate_fpr", TN: "rate_tnr", FN: "rate_fnr" };

function makeContribScale(nodes){
  const vals = nodes
      .map(n => n.contrib)
      .filter(v => v !== undefined && !isNaN(v));
  const maxAbs = d3.max(vals.map(Math.abs)) || 0.001;
  return d3.scaleDiverging(d3.interpolateRdBu)
           .domain([ maxAbs, 0, -maxAbs ]);
}

/* ========= 2. Sankey setup =============================== */
const { sankey, sankeyLinkHorizontal } = d3;   // d3-sankey plugin loaded


const sankeyGen = sankey()
      .nodeWidth(14)
      .nodePadding(16)
      .extent([[1, 1], [sankeySvgW - 1, sankeySvgH - 6]]);

const svg = d3.select("#sankey-placeholder")
              .append("svg")
              .attr("width", "100%")  // Fill container width
              .attr("height", sankeySvgH);

/* ========= 3. Ensure Age checkbox ticked ================= */
d3.select("#age").property("checked", true);

/* ========= 4. UI LISTENERS =============================== */
d3.selectAll("#feature-options input[type=checkbox]")
  .on("change", function () {
      const boxes = d3.selectAll("#feature-options input:checked").nodes();
      if (boxes.length > 2) {            // more than 2 ⇒ undo last click
          this.checked = false;
          return;                         // ignore
      }
      currentProtected = boxes.map(d => d.id);
      updateAll();                        // also triggers heat-map via updateAll
  });

d3.selectAll("#metric-options input[type=radio]")
  .on("change", async function () {
      currentMetric = this.id;
      updateMetricEquation();  // NEW
      await updateAll();
  });

// Deselect metric button
d3.select("#deselect-metric-btn")
  .on("click", async function () {
      // Uncheck all radio buttons
      d3.selectAll("#metric-options input[type=radio]").property("checked", false);
      currentMetric = null;
      updateMetricEquation();
      await updateAll();
  });

// Metric help button - toggle definition display
d3.select("#metric-help-btn")
  .on("click", function () {
      const defDiv = d3.select("#metric-definition");
      const isVisible = defDiv.style("display") !== "none";
      defDiv.style("display", isVisible ? "none" : "block");
  });

// Confusion matrix reset button - clear all confusion bar selections
d3.select("#confusion-reset-btn")
  .on("click", function () {
      // Clear outcome and group selections
      selectedOutcomes.clear();
      selectedGroups.clear();

      // Clear stream selections from confusion bars (outcome-based only)
      const keysToDelete = [];
      for (const [key, sel] of window.streamSelections.entries()) {
        if (sel.outcome && !sel.feature) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(k => window.streamSelections.delete(k));

      // Update visualizations
      updateConfusionBarStyles();
      renderPCP();
      updateFeatureDistribution();
      renderSliceMetrics();
  });

// Score distribution reset button - clear distribution bar selections
d3.select("#distribution-reset-btn")
  .on("click", function () {
      // Clear stream selections from distribution bars (feature-based only)
      const keysToDelete = [];
      for (const [key, sel] of window.streamSelections.entries()) {
        if (sel.feature) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(k => window.streamSelections.delete(k));

      // Update visualizations
      renderPCP();
      updateFeatureDistribution();
  });

d3.select("#threshold-slider")
  .on("input", async function () {
      currentThr = +this.value;
      await updateAll();
  });


/* ========= 5. FETCH + REDRAW ============================= */
async function updateAll() {
  try {
    const protStr = Array.isArray(currentProtected)
               ? currentProtected.join(",")
               : currentProtected;
    // Load PCP data FIRST (needed for confusion bar computation)
    if (!state.data.length || state._thr !== currentThr) {
      const pcp = await d3.json(`${API_ROOT}/pcp_data?thr=${currentThr}`);
      window.state = { ...pcp, _thr: currentThr };
      state.data.forEach((d, i) => { if (d._id == null) d._id = i; });
      window.state.numericKeys = window.state.numericKeys.filter(k => !PCP_HIDE.has(k));
      window.state.catKeys     = window.state.catKeys.filter(k => !PCP_HIDE.has(k));
      pcpOrder = [];                 // force recompute axis order on new data

      buildPcpFeatureControls();
    }

    // NOW load sankey/confusion data and draw
    const data = await d3.json(
    `${API_ROOT}/sankey?metric=${currentMetric}` +
    `&protected=${protStr}&thr=${currentThr}`
     );
    console.log("📊 About to call drawConfusionBars with data:", data);
    console.log("📊 state.data available?", state?.data?.length);

    // Save data for later updates (e.g., PCP brushing)
    window._lastSankeyData = data;

    // If neutralization is active, update the original data for the new protected group
    if (window.NEUTRAL && window.NEUTRAL.active) {
      window.NEUTRAL.originalData = data;
      // Also update original state data with current non-neutralized state
      if (window.NEUTRAL.backup) {
        window.NEUTRAL.originalStateData = deepCloneRows(window.NEUTRAL.backup);
      }
    }

    // Use confusion bars instead of Sankey
    drawConfusionBars(data);
    console.log("📊 drawConfusionBars completed");
    updateLinkLegend();
    updateMetricEquation();

    if (!window._neutralUiInit) {
      initNeutralizeUI({ features: [...state.numericKeys, ...state.catKeys] });
      window._neutralUiInit = true;
    }
    renderPCP();
    renderGroupBars();
    renderBaselineCountsChart();
    testDistributionSystem();

  } catch (err) {
    console.error("API error:", err);
  }
}
// Add this test right after renderPCP() is called in updateAll()
// This will help verify the distribution system is wired:

function testDistributionSystem() {
  console.log("=== Distribution System Debug ===");
  
  // 1. Check container exists
  const container = d3.select("#feature-distribution-chart");
  console.log("Container found:", !container.empty());
  console.log("Container size:", container.node()?.getBoundingClientRect());
  
  // 2. Check state
  console.log("State data loaded:", state?.data?.length);
  console.log("Numeric keys:", state?.numericKeys?.slice(0, 3));
  console.log("Categorical keys:", state?.catKeys?.slice(0, 3));
  
  // 3. Check group color scale
  console.log("GROUP_COLOR_SCALE exists:", typeof GROUP_COLOR_SCALE === 'function');
  console.log("Selected groups:", Array.from(selectedGroups || []));
  console.log("Selected outcomes:", Array.from(selectedOutcomes || []));
  
  // 4. Try rendering with first numeric feature
  if (state?.numericKeys?.length > 0) {
    const testFeature = state.numericKeys[0];
    console.log("Testing with feature:", testFeature);
    renderFeatureDistribution(testFeature);
    console.log("Distribution rendered");
  }
}

// Call this after data loads to verify everything works
// Add to end of updateAll(): testDistributionSystem();

/* ========= 6. DRAW Sankey ================================= */
function makeMetricScale(nodes){
  const vals = nodes.map(n => n.metric_val)
                    .filter(v => v != null && isFinite(v));
  if (!vals.length) {
    // safe default
    return d3.scaleSequential(d3.interpolateBlues).domain([0, 1]);
  }
  let minV = d3.min(vals), maxV = d3.max(vals);
  if (minV === maxV) maxV = minV + 1e-6;   // avoid zero-width domain
  return d3.scaleSequential(d3.interpolateBlues).domain([minV, maxV]);
}


function drawSankey(data) {
  // ═══════════════════════════════════════════════════════════════
  // THE START: Initialize GROUP_COLOR_SCALE FIRST
  // ═══════════════════════════════════════════════════════════════
  
  if (!data.nodes || !data.nodes.length) return;

  // NEW: Transform data if neutralization is active
  const hasNeutral = window.NEUTRAL && window.NEUTRAL.active;



  // Extract group names from the data
  window.ALL_GROUP_NODE_NAMES = new Set(
    data.nodes
      // true middle-column group nodes only
      .filter(n =>
        !n.neutral &&               // ⬅️ exclude neutral “after” nodes
        n.name !== "GT+" &&
        n.name !== "GT-" &&
        !OUTS.has(n.name)
      )
      .map(n => n.name)
  );
    
  // Drop any selections that don't exist in this render
  for (const g of Array.from(selectedGroups)) {
    if (!window.ALL_GROUP_NODE_NAMES.has(g)) selectedGroups.delete(g);
  }

  // Build / preserve stable color scale for group nodes
  const groupNames = Array.from(window.ALL_GROUP_NODE_NAMES).sort(d3.ascending);

  // Check if we need to rebuild the scale
  // NEVER rebuild during active neutralization - colors must stay stable
  const isNeutralizationActive = window.NEUTRAL && window.NEUTRAL.active;

  const needNewScale =
    !GROUP_COLOR_SCALE ||
    !window.LAST_GROUP_NAMES ||
    (!isNeutralizationActive && (
      window.LAST_GROUP_NAMES.length !== groupNames.length ||
      !window.LAST_GROUP_NAMES.every((g, i) => g === groupNames[i])
    ));

  if (needNewScale) {
    const palette = (window.genContrastingPalette)
      ? window.genContrastingPalette(groupNames.length)
      : d3.schemeTableau10;

    GROUP_COLOR_SCALE = d3.scaleOrdinal()
      .domain(groupNames)
      .range(palette);

    window.LAST_GROUP_NAMES = groupNames.slice();
    console.log("✓ GROUP_COLOR_SCALE initialized with", groupNames.length, "groups");
  } else {
    console.log("✓ GROUP_COLOR_SCALE preserved", isNeutralizationActive ? "(neutralization active)" : "(same groups)");
  }

  // ═══════════════════════════════════════════════════════════════
  // NOW safe to use GROUP_COLOR_SCALE throughout
  // ═══════════════════════════════════════════════════════════════

  svg.selectAll("*").remove();

  // Ensure globals used by external helpers exist
  window.isFirstHop      = window.isFirstHop      || (l => (l.source.name === "GT+" || l.source.name === "GT-"));
  window.FADE_OP_OUTCOME = (typeof window.FADE_OP_OUTCOME === "number") ? window.FADE_OP_OUTCOME : 0.15;
  window.FADE_OP_GT      = (typeof window.FADE_OP_GT      === "number") ? window.FADE_OP_GT      : 0.12;

  const BASE_OP_FIRST_HOP = 0.85;
  const BASE_OP_OTHER     = 0.60;

  // Layout with stable panel height (prevents flicker)
  svg.attr("height", sankeySvgH);
  // sankeyGen.extent([[1,1],[sankeySvgW - 1, sankeySvgH - 6]]);

  const graph = sankeyGen({
    nodes: data.nodes.map(d => ({ ...d })),   // clone so d3-sankey can mutate
    links: data.links.map(d => ({ ...d }))
  });
  if (state && state.data && state.data.length) {
    if (window._skipGroupBarsRender) {
      // We explicitly rendered from applyNeutralization, so skip once
      window._skipGroupBarsRender = false;
    } else {
      renderGroupBars();
    }
  }

  // === Fixed scaling for the Group column (to normalize Group→Outcome widths) ===
  const groupNodes = graph.nodes.filter(n => !OUTS.has(n.name) && n.name !== "GT+" && n.name !== "GT-");
  const groupDepth = d3.mode(groupNodes.map(n => n.depth));
  const colNodes   = graph.nodes.filter(n => n.depth === groupDepth && !OUTS.has(n.name) && n.name !== "GT+" && n.name !== "GT-");

  // Sum of values in that column
  const colSum = d3.sum(colNodes, n => n.value);

  // Available vertical space must match the Sankey extent you set:
  const availableH = (sankeySvgH - 1) - 6;          // matches [[1,1],[W-1,H-6]]
  const pad        = sankeyGen.nodePadding() * Math.max(0, colNodes.length - 1);

  // Column scale
  window._groupDepth = groupDepth;
  window._kGroup     = (availableH - pad) / colSum;



  // Center the diagram
  const xOffset = (sankeySvgW - d3.max(graph.nodes, d => d.x1)) / 2;
  const g = svg.append("g").attr("transform", `translate(${xOffset},0)`);

  renderNodeLegend();
  renderNumDenLegend(); 

  /* =================== LINKS =================== */
  const linksG = g.append("g").attr("class", "links").attr("fill", "none");

  const linkSel = linksG.selectAll("path.sankey-link")
    .data(graph.links, d => `${d.source.name}-${d.target.name}-${d.index}`)
    .join("path")
      .attr("class", "sankey-link")
      .attr("d", sankeyLinkHorizontal())
      .attr("stroke-width", function(d) {
        // Pre-calculate and cache the width on first render
        const w = linkWidth(d);
        d._normalizedWidth = w;  // Store it
        return w;
      })
      .attr("stroke", linkStroke)
      .each(function(d){
        d._baseOpacity = window.isFirstHop(d) ? BASE_OP_FIRST_HOP : BASE_OP_OTHER;
      })
      .attr("stroke-opacity", d => d._baseOpacity)
      .attr("pointer-events", "stroke");

  function refreshLinks(){
    linkSel
      .attr("stroke",        linkStroke)
      .attr("stroke-opacity", linkOpacity)
      .attr("stroke-width", function(d) {
        // Use cached normalized width instead of recalculating
        return d._normalizedWidth !== undefined ? Math.max(1, d._normalizedWidth) : Math.max(1, d.width);
      });
    updateLinkLegend();
  }

  function refreshLinkStyling() {
    linkSel
      .attr("stroke", d => {
        // First hop (GT+ / GT-) stays share-colored
        const fromGT = (d.source.name === "GT+" || d.source.name === "GT-");
        if (fromGT) return shareScale(d.share ?? 0);

        // For Group → Outcome links, prefer the per-stream color if selected
        const key = streamKeyFromLink(d);
        const sel = window.streamSelections?.get(key);

        if (sel && sel.color) {
          return sel.color;  // ← the unique color assigned
        }
        if (d._hovering) {
          return "#83a0b6ff";
        }

        // Default (not selected / not hovering): your existing neutral/rate color
        return linkStroke(d);
      })
      .attr("stroke-width", d => {
        // Use cached normalized width
        const baseWidth = d._normalizedWidth !== undefined 
          ? d._normalizedWidth 
          : Math.max(2, d.width);
        
        const active = d._hovering || (window.streamSelections?.has(streamKeyFromLink(d)));
        return active ? Math.max(3, baseWidth) : baseWidth;
      })
      .attr("stroke-opacity", d => {
        if (d._hovering) return 0.95;
        if (window.streamSelections?.has(streamKeyFromLink(d))) return 0.85;
        return d._baseOpacity;
      });
  }

  // HOVER: brighten just this stream
  linkSel
    .on("mouseenter", function(_, d) {
      d._hovering = true;
      refreshLinkStyling();
    })
    .on("mouseleave", function(_, d) {
      d._hovering = false;
      refreshLinkStyling();
    });

  // CLICK: toggle multi-select (Group→Outcome only)
  linkSel.on("click", (event, d) => {
    const isFromGT = (d.source?.name === "GT+" || d.source?.name === "GT-");
    const isGroupToOutcome = !isFromGT && OUTS.has(d.target?.name);
    if (!isGroupToOutcome) return;

    const groupName   = d.source.name;
    const outcomeName = d.target.name;
    const key = streamKeyFromLink(d);

    if (window.streamSelections.has(key)) {
      window.streamSelections.delete(key);
    } else {
      const rows = (state?.data || []).filter(r =>
        rowMatchesGroup(r, groupName) && rowOutcome(r) === outcomeName
      );
      const ids = rows.map(r => r.id ?? r._id).filter(id => id != null);
      const pick = ids.length > MAX_STREAM_ROWS
        ? d3.shuffle(ids.slice()).slice(0, MAX_STREAM_ROWS)
        : ids.slice();

      window.streamSelections.set(key, {
        group: groupName,
        outcome: outcomeName,
        ids: new Set(pick),
        color: OUTCOME_COLORS[outcomeName] || "#666"
      });
    }

    assignStreamColors();
    refreshLinkStyling();
    renderPCP();
    updateFeatureDistribution();
    renderSliceMetrics(); 
  });

  // Tooltips (added separately so linkSel stays a PATH selection)
  linkSel.selectAll("title")
        .data(d => [d])
        .join("title")
        .text(d => {
          const isTransition =
            d.neutral === true ||      // we set this on post-neutralization links/nodes
            d.fromOutcome != null ||   // also set in transformDataForNeutralizedSankey
            d.toOutcome != null;

          if (isTransition) {
            // For TP → TP', FN → TP', etc. just show counts
            const count = d.value;  // or d.count if you stored it separately
            return `${d.source.name} → ${d.target.name}\ncount: ${count} rows`;
          }

          // Baseline Sankey links (GT→Group, Group→TP/FP/TN/FN): show fraction %
          const frac = d.share != null ? d.share : d.value;
          const pct  = (frac * 100).toFixed(1);
          return `${d.source.name} → ${d.target.name}\nfraction: ${pct} %`;
        });

  /* =================== NODES =================== */
  const nodesG = g.append("g").attr("class", "nodes");

  const nodeRects = nodesG.selectAll("rect")
    .data(graph.nodes, d => d.name)
    .join("rect")
      .attr("x", d => d.x0)
      .attr("y", d => d.y0)
      .attr("width",  d => d.x1 - d.x0)
      .attr("height", d => d.y1 - d.y0)
      .attr("fill", d => {
                      if (d.neutral) {
                        // Lighten the original color for neutralized nodes
                        const orig = nodeColor({...d, name: d.name.replace("_neutral", "")});
                        const hsl = d3.hsl(orig);
                        hsl.l = Math.min(1, hsl.l + 0.2);
                        return hsl.formatHex();
                      }
                      return nodeColor(d);
                    })
      .attr("stroke", "#000");

  nodeRects.classed("sankey-node", true);

  // after nodeRects are created
  function applyGroupNodeStyles() {
    nodeRects
      // classes
      .classed("is-context", d => {
        const isGroup = !OUTS.has(d.name) && d.name !== "GT+" && d.name !== "GT-";
        return isGroup && window.contextGroupIds.has(d.name);
      })
      .classed("is-selected", d => {
        const isGroup = !OUTS.has(d.name) && d.name !== "GT+" && d.name !== "GT-";
        return isGroup && selectedGroups.has(d.name);
      })
      .classed("is-muted", d => {
        const isGroup = !OUTS.has(d.name) && d.name !== "GT+" && d.name !== "GT-";
        if (!isGroup) return false;
        return window.contextGroupIds.size > 0 && !window.contextGroupIds.has(d.name);
      })
      .classed("is-outcome-selected", d => OUTS.has(d.name) && selectedOutcomes.has(d.name))

      // stroke width for BOTH groups and outcomes
      .attr("stroke-width", d => {
        if (OUTS.has(d.name)) {
          return selectedOutcomes.has(d.name) ? 3 : 1;     // outcomes
        }
        if (d.name === "GT+" || d.name === "GT-") return 1; // ground-truth hubs
        return selectedGroups.has(d.name) ? 3 : 1;          // groups
      });
  }
  window.applyGroupNodeStyles = applyGroupNodeStyles;

  // Combined hover behavior:
  //  - Hover TP/FP/TN/FN: color Group→that outcome by rate, fade others
  //  - Hover GT+/GT−: fade the other GT's first-hop links
  nodeRects.on("click", function (event, d) {
    // 1) Outcome nodes → toggle selectedOutcomes
    if (OUTS.has(d.name)) {
      toggleOutcomeSelection(d.name);
      d3.select(this).attr("stroke-width", selectedOutcomes.has(d.name) ? 3 : 1);
      updateFeatureDistribution();
      renderSliceMetrics(); 
      return;
    }

    // 2) GT nodes → ignore for PCP selection
    if (d.name === "GT+" || d.name === "GT-") return;

    // 3) Protected group nodes (middle column)
    const gname = d.name;

    // SHIFT = toggle CONTEXT band for this group
    if (event.shiftKey) {
      window.contextGroupIds = window.contextGroupIds || new Set();
      if (window.contextGroupIds.has(gname)) {
        window.contextGroupIds.delete(gname);
      } else {
        window.contextGroupIds.add(gname);
      }
      renderPCP();
      applyGroupNodeStyles();
      return;
    }

    // Regular click: toggle group selection
    if (selectedGroups.has(gname)) {
      selectedGroups.delete(gname);
      d3.select(this).attr("stroke-width", 1);
    } else {
      selectedGroups.add(gname);
      d3.select(this).attr("stroke-width", 3);
    }
    renderPCP();
    applyGroupNodeStyles();
    renderSliceMetrics(); 
  });

  nodeRects
  .on("mouseenter", function (event, d) {
    if (OUTS.has(d.name)) {
      hoverOutcome = d.name;   // TP/FP/TN/FN → color Group→that outcome by its rate
      refreshLinks();
    } else if (d.name === "GT+" || d.name === "GT-") {
      hoverGT = d.name;        // GT hover → fade the other GT's first hop
      refreshLinks();
    }
  })
  .on("mouseleave", function (event, d) {
    let changed = false;
    if (OUTS.has(d.name) && hoverOutcome != null) {
      hoverOutcome = null; changed = true;
    }
    if ((d.name === "GT+" || d.name === "GT-") && hoverGT != null) {
      hoverGT = null; changed = true;
    }
    if (changed) refreshLinks();
  })
  .style("cursor","pointer");

  // Node tooltips
  nodeRects.selectAll("title").data(d => [d]).join("title")
    .text(d => {
      if (d.metric_val !== undefined) {
        return `${d.name}\n${currentMetric}: ${d.metric_val.toFixed(3)}`;
      }
      return d.name;
    });

  /* =================== LABELS =================== */
  const labelsG = g.append("g").attr("class", "labels").style("font", "12px sans-serif");

  labelsG.selectAll("text")
    .data(graph.nodes, d => d.name)
    .join("text")
      .attr("x", d => d.x0 - 6)
      .attr("y", d => (d.y1 + d.y0) / 2)
      .attr("dy", "0.35em")
      .attr("text-anchor", "end")
      .text(d => {
                if (d.neutral) {
                      return d.name.replace("_neutral", "") + "*";
                    }
                    return d.name;
                  })
      .style("font-weight", d => {
        const isOutcome = ["TP","FP","TN","FN"].includes(d.name);
        return isOutcome ? "bold" : "normal";
      })
      .style("fill", d => d.neutral ? "#d62728" : "#000")
      .style("font-style", d => d.neutral ? "italic" : "normal")
      .attr("fill", d => {
        if (d.name === "TP" || d.name === "TN") return "#1d5665ff"; // green
        if (d.name === "FP" || d.name === "FN") return "#742c2cff"; // red
        return "#000"; // default black
      })
      .filter(d => d.x0 < sankeySvgW / 2)
      .attr("x", d => d.x1 + 6)
      .attr("text-anchor", "start");

  updateLinkLegend();
  applyGroupNodeStyles();
}

/* ========= 6B. CONFUSION BAR VISUALIZATION ============== */

function computeConfusionBarData(data, filteredRows = null) {
  console.log("=== Computing Confusion Bar Data ===");
  console.log("Input data:", data);
  console.log("Filtered rows:", filteredRows ? filteredRows.length : "none (using all data)");

  // Extract group names (middle column nodes)
  const groupNames = [];
  const groupNodes = data.nodes.filter(n =>
    !n.neutral &&
    !n.isPostNeutral &&
    n.name !== "GT+" &&
    n.name !== "GT-" &&
    !OUTS.has(n.name) &&
    !n.name.endsWith("'")  // Exclude TP', FP', TN', FN'
  );
  groupNodes.forEach(n => groupNames.push(n.name));

  console.log("Group names found:", groupNames);
  console.log("Total links:", data.links?.length);

  // Build confusion counts from actual row data instead of links
  const confusionCounts = {};
  groupNames.forEach(g => {
    confusionCounts[g] = { TP: 0, FN: 0, FP: 0, TN: 0 };
  });

  // Use filteredRows if provided, otherwise use state.data
  const rowsToUse = filteredRows || (state && state.data) || [];

  if (rowsToUse.length > 0) {
    console.log("Computing from", filteredRows ? "filtered rows" : "state.data", "with", rowsToUse.length, "rows");
    if (!filteredRows) {
      console.log("Sample row:", rowsToUse[0]);
      console.log("Current protected:", currentProtected);
    }

    let matchedRows = 0;
    rowsToUse.forEach(row => {
      const outcome = rowOutcome(row);
      if (!outcome) return;

      // Find which group this row belongs to
      for (const groupName of groupNames) {
        if (rowMatchesGroup(row, groupName)) {
          confusionCounts[groupName][outcome]++;
          matchedRows++;
          break; // Each row belongs to only one group
        }
      }
    });

    console.log(`Matched ${matchedRows} rows to groups`);
  } else {
    console.warn("No state.data available, falling back to link values");
    // Fallback: try to parse links
    data.links.forEach(link => {
      const sourceName = link.source?.name || link.source;
      const targetName = link.target?.name || link.target;

      if (groupNames.includes(sourceName) && OUTS.has(targetName)) {
        // Link value might be a fraction, multiply by total dataset size
        const count = Math.round((link.value || link.share || 0) * (state?.data?.length || 1000));
        confusionCounts[sourceName][targetName] = count;
      }
    });
  }

  console.log("Confusion counts:", confusionCounts);

  // Compute totals
  const outcomeTotals = { TP: 0, FN: 0, FP: 0, TN: 0 };
  const groupTotals = {};

  groupNames.forEach(g => {
    groupTotals[g] = confusionCounts[g].TP + confusionCounts[g].FN +
                     confusionCounts[g].FP + confusionCounts[g].TN;
    outcomeTotals.TP += confusionCounts[g].TP;
    outcomeTotals.FN += confusionCounts[g].FN;
    outcomeTotals.FP += confusionCounts[g].FP;
    outcomeTotals.TN += confusionCounts[g].TN;
  });

  const grandTotal = outcomeTotals.TP + outcomeTotals.FN + outcomeTotals.FP + outcomeTotals.TN;

  console.log("Outcome totals:", outcomeTotals);
  console.log("Grand total:", grandTotal);

  return {
    groupNames,
    confusionCounts,
    outcomeTotals,
    groupTotals,
    grandTotal
  };
}

function drawConfusionBars(data, filteredRows = null) {
  console.log("=== DRAW CONFUSION BARS CALLED ===");
  console.log("Data received:", data);
  console.log("Has nodes?", data?.nodes?.length);
  console.log("Has links?", data?.links?.length);
  console.log("Filtered rows?", filteredRows ? filteredRows.length : "none");

  if (!data.nodes || !data.nodes.length) {
    console.warn("No nodes in data, returning early");
    return;
  }

  // Initialize GROUP_COLOR_SCALE (same logic as in drawSankey)
  window.ALL_GROUP_NODE_NAMES = new Set(
    data.nodes
      .filter(n =>
        !n.neutral &&
        !n.isPostNeutral &&
        n.name !== "GT+" &&
        n.name !== "GT-" &&
        !OUTS.has(n.name) &&
        !n.name.endsWith("'")  // Exclude TP', FP', TN', FN'
      )
      .map(n => n.name)
  );

  const groupNames = Array.from(window.ALL_GROUP_NODE_NAMES).sort(d3.ascending);
  const isNeutralizationActive = window.NEUTRAL && window.NEUTRAL.active;

  const needNewScale =
    !GROUP_COLOR_SCALE ||
    !window.LAST_GROUP_NAMES ||
    (!isNeutralizationActive && (
      window.LAST_GROUP_NAMES.length !== groupNames.length ||
      !window.LAST_GROUP_NAMES.every((g, i) => g === groupNames[i])
    ));

  if (needNewScale) {
    const palette = (window.genContrastingPalette)
      ? window.genContrastingPalette(groupNames.length)
      : d3.schemeTableau10;

    GROUP_COLOR_SCALE = d3.scaleOrdinal()
      .domain(groupNames)
      .range(palette);

    window.LAST_GROUP_NAMES = groupNames.slice();
  }

  // Compute confusion bar data with optional filtered rows
  const barData = computeConfusionBarData(data, filteredRows);
  const OUTCOME_ORDER = ["TP", "FN", "FP", "TN"];

  // Layout parameters - Use fixed bar heights and allow scrolling
  // Get actual container width dynamically
  const containerNode = document.getElementById('sankey-placeholder');
  const containerWidth = containerNode ? containerNode.getBoundingClientRect().width : sankeySvgW;

  const margin = { top: 30, right: 150, bottom: 55, left: 150};

  // Calculate minimum width needed for content (adjust based on number of groups/outcomes)
  const minContentWidth = 400; // Minimum width for bars
  const width = Math.max(containerWidth - margin.left - margin.right, minContentWidth);
  const totalWidth = width + margin.left + margin.right;

  // Fixed bar heights - don't shrink to fit container
  const gtBarHeight = 20;  // Ground truth bar (reduced from 30)
  const overallBarHeight = 30;  // Overall bar (reduced from 45)
  const groupBarHeight = isNeutralizationActive ? 35 : 25;  // Increased when neutralization is active
  const rowGap = 4;  // Gap between GT and Overall bars

  // Extra spacing for visual grouping
  const overallToGroupGap = 12;  // Larger gap between Overall and first Group
  const groupSpacing = isNeutralizationActive ? 12 : 8;  // Spacing between groups (increased)

  // Calculate total height based on content, not container
  const totalHeight = margin.top + margin.bottom +
                      gtBarHeight + rowGap +
                      overallBarHeight + overallToGroupGap +  // Use larger gap here
                      (barData.groupNames.length * (groupBarHeight + groupSpacing));

  svg.selectAll("*").remove();
  svg.attr("width", totalWidth);
  svg.attr("height", totalHeight);

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left}, ${margin.top})`);

  // Calculate GT+ and GT- totals
  const gtPosTotal = barData.outcomeTotals.TP + barData.outcomeTotals.FN;
  const gtNegTotal = barData.outcomeTotals.FP + barData.outcomeTotals.TN;

  // Calculate widths for GT+ and GT- (left-aligned, no center anchor)
  const gtPosWidth = (gtPosTotal / barData.grandTotal) * width;
  const gtNegWidth = (gtNegTotal / barData.grandTotal) * width;

  // === GROUND TRUTH BAR ===
  const gtBarGroup = g.append("g")
    .attr("class", "gtBar")
    .attr("transform", `translate(0, 0)`);

  // Label
  gtBarGroup.append("text")
    .attr("x", -10)
    .attr("y", gtBarHeight / 2 + 4)
    .attr("text-anchor", "end")
    .attr("font-weight", "bold")
    .attr("font-size", "12px")
    .attr("fill", "#333")
    .text("Ground Truth");

  // GT+ (TP+FN)
  gtBarGroup.append("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", gtPosWidth)
    .attr("height", gtBarHeight)
    .attr("fill", GT_POS_COLOR)
    .attr("stroke", "#333")
    .attr("stroke-width", 1)
    .attr("opacity", 0.3);

  gtBarGroup.append("text")
    .attr("x", gtPosWidth / 2)
    .attr("y", gtBarHeight / 2 + 4)
    .attr("text-anchor", "middle")
    .attr("font-size", "11px")
    .attr("font-weight", "600")
    .attr("fill", "#333")
    .text(`GT+ (n=${gtPosTotal})`);

  // GT- (FP+TN)
  gtBarGroup.append("rect")
    .attr("x", gtPosWidth)
    .attr("y", 0)
    .attr("width", gtNegWidth)
    .attr("height", gtBarHeight)
    .attr("fill", GT_NEG_COLOR)
    .attr("stroke", "#333")
    .attr("stroke-width", 1)
    .attr("opacity", 0.3);

  gtBarGroup.append("text")
    .attr("x", gtPosWidth + gtNegWidth / 2)
    .attr("y", gtBarHeight / 2 + 4)
    .attr("text-anchor", "middle")
    .attr("font-size", "11px")
    .attr("font-weight", "600")
    .attr("fill", "#333")
    .text(`GT- (n=${gtNegTotal})`);

  // === OVERALL BAR (left-aligned, outcome-normalized with group sub-stacks) ===
  const overallBarGroup = g.append("g")
    .attr("class", "overallBar")
    .attr("transform", `translate(0, ${gtBarHeight + rowGap})`);

  // Label with subtitle
  overallBarGroup.append("text")
    .attr("x", -10)
    .attr("y", overallBarHeight / 2 - 6)
    .attr("text-anchor", "end")
    .attr("font-weight", "bold")
    .attr("font-size", "12px")
    .attr("fill", "#333")
    .text("Prediction Outcomes");

  overallBarGroup.append("text")
    .attr("x", -10)
    .attr("y", overallBarHeight / 2 + 8)
    .attr("text-anchor", "end")
    .attr("font-size", "9px")
    .attr("fill", "#666")
    .attr("font-style", "italic")
    .text("(by outcome)");

  let xPos = 0;

  OUTCOME_ORDER.forEach(outcome => {
    const outcomeTotal = barData.outcomeTotals[outcome];
    const outcomeWidth = (outcomeTotal / barData.grandTotal) * width;

    // Sub-stack by groups within this outcome
    let yPos = 0;
    barData.groupNames.forEach(group => {
      const count = barData.confusionCounts[group][outcome];
      const segmentHeight = outcomeTotal > 0 ? (count / outcomeTotal) * overallBarHeight : 0;

      if (count > 0) {
        overallBarGroup.append("rect")
          .datum({ outcome, group, count, type: 'overall' })
          .attr("class", `bar-segment overall-${outcome} overall-${outcome}-${group}`)
          .attr("x", xPos)
          .attr("y", yPos)
          .attr("width", outcomeWidth)
          .attr("height", segmentHeight)
          .attr("fill", GROUP_COLOR_SCALE(group))
          .attr("stroke", "#fff")
          .attr("stroke-width", 1)
          .attr("opacity", 0.85)
          .style("cursor", "pointer")
          .on("mouseenter", function(event, d) {
            handleSegmentHover(d, true);
            showTooltip(event, d, barData);
          })
          .on("mouseleave", function(event, d) {
            handleSegmentHover(d, false);
            hideTooltip();
          })
          .on("click", function(event, d) {
            handleSegmentClick(event, d);
          });

        yPos += segmentHeight;
      }
    });

    xPos += outcomeWidth;
  });

  // === GROUP ROWS (group-normalized, center-anchored if neutralized) ===
  const groupRowsGroup = g.append("g")
    .attr("class", "groupRows")
    .attr("transform", `translate(0, ${gtBarHeight + rowGap + overallBarHeight + overallToGroupGap})`);

  // Calculate center anchor point (between TP+FN and FP+TN)
  const gtPosRatio = gtPosTotal / barData.grandTotal;
  const centerAnchor = gtPosRatio * width;

  // If neutralization is active, compute original data for comparison
  let originalBarData = null;
  if (isNeutralizationActive && window.NEUTRAL.originalData) {
    // Use the original state data rows instead of filtered rows for accurate comparison
    const originalRows = window.NEUTRAL.originalStateData || filteredRows;
    originalBarData = computeConfusionBarData(window.NEUTRAL.originalData, originalRows);
  }

  const barSpacing = isNeutralizationActive ? 3 : 0; // Space between original and neutralized bars
  const perBarHeight = isNeutralizationActive ? (groupBarHeight - barSpacing) / 2 : groupBarHeight;
  // groupSpacing is already defined above at line 959

  barData.groupNames.forEach((group, idx) => {
    const rowY = idx * (groupBarHeight + groupSpacing);
    const rowGroup = groupRowsGroup.append("g")
      .attr("class", `group-row group-row-${group}`)
      .attr("transform", `translate(0, ${rowY})`);

    const groupTotal = barData.groupTotals[group];

    // Calculate the leftmost extent of the bar for this group
    const counts = barData.confusionCounts[group];
    const total = barData.groupTotals[group];
    const tpfnWidth = total > 0 ? ((counts.TP + counts.FN) / total) * width : 0;
    const leftExtent = centerAnchor - tpfnWidth;

    // Group label with count - anchored to left of bar
    rowGroup.append("text")
      .attr("x", leftExtent - 10) // 10px to the left of the bar start
      .attr("y", groupBarHeight / 2 - 5)
      .attr("text-anchor", "end")
      .attr("font-size", "11px")
      .attr("fill", GROUP_COLOR_SCALE(group))
      .attr("font-weight", "600")
      .text(group);

    // Show group total count
    rowGroup.append("text")
      .attr("x", leftExtent - 10) // 10px to the left of the bar start
      .attr("y", groupBarHeight / 2 + 8)
      .attr("text-anchor", "end")
      .attr("font-size", "8px")
      .attr("fill", "#999")
      .text(`n=${groupTotal}`);

    // Function to draw a bar (original or neutralized)
    const drawBar = (confusionData, yOffset, label) => {
      const counts = confusionData.confusionCounts[group];
      const total = confusionData.groupTotals[group];

      // Calculate widths for each section
      const tpCount = counts.TP || 0;
      const fnCount = counts.FN || 0;
      const fpCount = counts.FP || 0;
      const tnCount = counts.TN || 0;

      const posTotal = tpCount + fnCount;
      const negTotal = fpCount + tnCount;

      const tpWidth = total > 0 ? (tpCount / total) * width : 0;
      const fnWidth = total > 0 ? (fnCount / total) * width : 0;
      const fpWidth = total > 0 ? (fpCount / total) * width : 0;
      const tnWidth = total > 0 ? (tnCount / total) * width : 0;

      // Draw from center anchor point
      // Left side (TP+FN, right to left)
      let xPos = centerAnchor;

      // Helper function to get metric class, border style, and opacity
      const getMetricStyle = (outcome) => {
        // If no metric is selected, show all segments with full opacity and white borders
        if (!currentMetric) {
          return { cssClass: "", stroke: "#fff", strokeWidth: 1, segmentOpacity: 0.85 };
        }

        const num = metricNumerator(currentMetric);
        const denom = metricDenominator(currentMetric);
        const isInNum = Array.isArray(num) ? num.includes(outcome) : outcome === num;
        const isInDenom = denom.includes(outcome);

        if (isInNum) {
          // Numerator - full opacity, green border
          return { cssClass: "metric-numerator", stroke: "#10b981", strokeWidth: 6, segmentOpacity: 1.0 };
        } else if (isInDenom) {
          // Denominator only - mid opacity, amber border
          return { cssClass: "metric-denominator-only", stroke: "#f59e0b", strokeWidth: 6, segmentOpacity: 0.8 };
        }
        // Not in metric - least opacity, no border
        return { cssClass: "", stroke: "none", strokeWidth: 0, segmentOpacity: 0.2 };
      };

      // FN (left of center)
      if (fnCount > 0) {
        const metricStyle = getMetricStyle('FN');
        rowGroup.append("rect")
          .datum({ outcome: 'FN', group, count: fnCount, type: 'group', label })
          .attr("class", `bar-segment group-${group}-FN ${label} ${metricStyle.cssClass}`)
          .attr("x", xPos - fnWidth)
          .attr("y", yOffset)
          .attr("width", fnWidth)
          .attr("height", perBarHeight)
          .attr("fill", OUTCOME_COLORS['FN'])
          .attr("stroke", metricStyle.stroke)
          .attr("stroke-width", metricStyle.strokeWidth)
          .style("opacity", metricStyle.segmentOpacity)
          .style("cursor", "pointer")
          .on("mouseenter", function(event, d) {
            handleSegmentHover(d, true);
            showTooltip(event, d, confusionData);
          })
          .on("mouseleave", function(event, d) {
            handleSegmentHover(d, false);
            hideTooltip();
          })
          .on("click", function(event, d) {
            handleSegmentClick(event, d);
          });
      }
      xPos -= fnWidth;

      // TP (further left)
      if (tpCount > 0) {
        const metricStyle = getMetricStyle('TP');
        rowGroup.append("rect")
          .datum({ outcome: 'TP', group, count: tpCount, type: 'group', label })
          .attr("class", `bar-segment group-${group}-TP ${label} ${metricStyle.cssClass}`)
          .attr("x", xPos - tpWidth)
          .attr("y", yOffset)
          .attr("width", tpWidth)
          .attr("height", perBarHeight)
          .attr("fill", OUTCOME_COLORS['TP'])
          .attr("stroke", metricStyle.stroke)
          .attr("stroke-width", metricStyle.strokeWidth)
          .style("opacity", metricStyle.segmentOpacity)
          .style("cursor", "pointer")
          .on("mouseenter", function(event, d) {
            handleSegmentHover(d, true);
            showTooltip(event, d, confusionData);
          })
          .on("mouseleave", function(event, d) {
            handleSegmentHover(d, false);
            hideTooltip();
          })
          .on("click", function(event, d) {
            handleSegmentClick(event, d);
          });
      }

      // Right side (FP+TN, left to right from center)
      xPos = centerAnchor;

      // FP (right of center)
      if (fpCount > 0) {
        const metricStyle = getMetricStyle('FP');
        rowGroup.append("rect")
          .datum({ outcome: 'FP', group, count: fpCount, type: 'group', label })
          .attr("class", `bar-segment group-${group}-FP ${label} ${metricStyle.cssClass}`)
          .attr("x", xPos)
          .attr("y", yOffset)
          .attr("width", fpWidth)
          .attr("height", perBarHeight)
          .attr("fill", OUTCOME_COLORS['FP'])
          .attr("stroke", metricStyle.stroke)
          .attr("stroke-width", metricStyle.strokeWidth)
          .style("opacity", metricStyle.segmentOpacity)
          .style("cursor", "pointer")
          .on("mouseenter", function(event, d) {
            handleSegmentHover(d, true);
            showTooltip(event, d, confusionData);
          })
          .on("mouseleave", function(event, d) {
            handleSegmentHover(d, false);
            hideTooltip();
          })
          .on("click", function(event, d) {
            handleSegmentClick(event, d);
          });
      }
      xPos += fpWidth;

      // TN (further right)
      if (tnCount > 0) {
        const metricStyle = getMetricStyle('TN');
        rowGroup.append("rect")
          .datum({ outcome: 'TN', group, count: tnCount, type: 'group', label })
          .attr("class", `bar-segment group-${group}-TN ${label} ${metricStyle.cssClass}`)
          .attr("x", xPos)
          .attr("y", yOffset)
          .attr("width", tnWidth)
          .attr("height", perBarHeight)
          .attr("fill", OUTCOME_COLORS['TN'])
          .attr("stroke", metricStyle.stroke)
          .attr("stroke-width", metricStyle.strokeWidth)
          .style("opacity", metricStyle.segmentOpacity)
          .style("cursor", "pointer")
          .on("mouseenter", function(event, d) {
            handleSegmentHover(d, true);
            showTooltip(event, d, confusionData);
          })
          .on("mouseleave", function(event, d) {
            handleSegmentHover(d, false);
            hideTooltip();
          })
          .on("click", function(event, d) {
            handleSegmentClick(event, d);
          });
      }
    };

    // Draw bars
    if (isNeutralizationActive && originalBarData) {
      // Draw original bar on top
      drawBar(originalBarData, 0, 'original');
      // Draw neutralized bar below
      drawBar(barData, perBarHeight + barSpacing, 'neutralized');

      // Calculate the rightmost extent of bars for this group
      const originalCounts = originalBarData.confusionCounts[group];
      const originalTotal = originalBarData.groupTotals[group];
      const neutralizedCounts = barData.confusionCounts[group];
      const neutralizedTotal = barData.groupTotals[group];

      // Calculate widths
      const originalTPFN = ((originalCounts.TP + originalCounts.FN) / originalTotal) * width;
      const originalFPTN = ((originalCounts.FP + originalCounts.TN) / originalTotal) * width;
      const neutralizedTPFN = ((neutralizedCounts.TP + neutralizedCounts.FN) / neutralizedTotal) * width;
      const neutralizedFPTN = ((neutralizedCounts.FP + neutralizedCounts.TN) / neutralizedTotal) * width;

      // Find max extent (furthest right from center anchor)
      const originalRightExtent = centerAnchor + originalFPTN;
      const originalLeftExtent = centerAnchor - originalTPFN;
      const neutralizedRightExtent = centerAnchor + neutralizedFPTN;
      const neutralizedLeftExtent = centerAnchor - neutralizedTPFN;

      const maxOriginalExtent = Math.max(originalRightExtent, Math.abs(originalLeftExtent));
      const maxNeutralizedExtent = Math.max(neutralizedRightExtent, Math.abs(neutralizedLeftExtent));

      // Add small labels at the right end of bars
      rowGroup.append("text")
        .attr("x", maxOriginalExtent + 8)
        .attr("y", perBarHeight / 2 + 3)
        .attr("font-size", "9px")
        .attr("fill", "#999")
        .attr("text-anchor", "start")
        .text("before");

      rowGroup.append("text")
        .attr("x", maxNeutralizedExtent + 8)
        .attr("y", perBarHeight + barSpacing + perBarHeight / 2 + 3)
        .attr("font-size", "9px")
        .attr("fill", "#333")
        .attr("text-anchor", "start")
        .text("after");
    } else {
      // Single bar (no neutralization)
      drawBar(barData, 0, 'current');
    }
  });

  // === LEGENDS ===
  // Position legend at the bottom of the SVG, using the bottom margin space
  const legendY = totalHeight - margin.bottom + 8; // Position in bottom margin
  const legendGroup = svg.append("g")
    .attr("class", "confusion-bar-legends")
    .attr("transform", `translate(${margin.left}, ${legendY})`);

  // Outcome colors legend
  legendGroup.append("text")
    .attr("x", 0)
    .attr("y", 0)
    .attr("font-size", "11px")
    .attr("font-weight", "600")
    .attr("fill", "#555")
    .text("Outcomes:");

  let legendX = 70;
  OUTCOME_ORDER.forEach((outcome) => {
    const legendItem = legendGroup.append("g")
      .attr("transform", `translate(${legendX}, -8)`);

    legendItem.append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", 14)
      .attr("height", 14)
      .attr("fill", OUTCOME_COLORS[outcome])
      .attr("stroke", "#333")
      .attr("stroke-width", 1)
      .attr("rx", 2);

    legendItem.append("text")
      .attr("x", 18)
      .attr("y", 11)
      .attr("font-size", "10px")
      .attr("fill", "#333")
      .text(outcome);

    legendX += 50;
  });

  // Group colors legend (new row)
  legendGroup.append("text")
    .attr("x", 0)
    .attr("y", 20)
    .attr("font-size", "11px")
    .attr("font-weight", "600")
    .attr("fill", "#555")
    .text("Groups:");

  let groupLegendX = 70;
  barData.groupNames.forEach((group) => {
    const legendItem = legendGroup.append("g")
      .attr("transform", `translate(${groupLegendX}, 12)`);

    legendItem.append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", 14)
      .attr("height", 14)
      .attr("fill", GROUP_COLOR_SCALE(group))
      .attr("stroke", "#333")
      .attr("stroke-width", 1)
      .attr("rx", 2);

    legendItem.append("text")
      .attr("x", 18)
      .attr("y", 11)
      .attr("font-size", "10px")
      .attr("fill", "#333")
      .text(group);

    groupLegendX += Math.max(70, group.length * 7 + 35);
  });

  // Instructions legend
  legendGroup.append("text")
    .attr("x", 0)
    .attr("y", 45)
    .attr("font-size", "10px")
    .attr("font-style", "italic")
    .attr("fill", "#666")
    .text("💡 Click segments to filter • Hover for details");

  // Store reference for later updates
  window._confusionBarData = barData;
  window._confusionBarSvg = svg;

  // Apply initial selection states
  updateConfusionBarStyles();

  // Trigger group bars and other visualizations
  if (state && state.data && state.data.length) {
    if (window._skipGroupBarsRender) {
      window._skipGroupBarsRender = false;
    } else {
      renderGroupBars();
    }
  }

  // Note: renderNodeLegend() and renderNumDenLegend() not needed for confusion bars
  // (they were Sankey-specific legends)
}

function handleSegmentHover(d, isEntering) {
  if (!window._confusionBarSvg) return;

  const svg = window._confusionBarSvg;

  if (isEntering) {
    // Add hover class to matching segments
    if (d.type === 'overall') {
      // Hover on overall outcome segment: highlight all segments with that outcome
      svg.selectAll(`.bar-segment`)
        .classed("hover", seg => seg.outcome === d.outcome);
    } else if (d.type === 'group') {
      // Hover on group segment: highlight this segment and matching chunk in overall bar
      svg.selectAll(`.bar-segment`)
        .classed("hover", seg =>
          (seg.outcome === d.outcome && seg.group === d.group)
        );
    }
  } else {
    // Remove hover class
    svg.selectAll(".bar-segment").classed("hover", false);
  }
}

function showTooltip(event, d, barData) {
  const tooltip = d3.select("body").selectAll(".confusion-bar-tooltip").data([0])
    .join("div")
    .attr("class", "confusion-bar-tooltip")
    .style("position", "absolute")
    .style("background", "rgba(0, 0, 0, 0.85)")
    .style("color", "#fff")
    .style("padding", "8px 12px")
    .style("border-radius", "4px")
    .style("font-size", "12px")
    .style("pointer-events", "none")
    .style("z-index", "10000")
    .style("line-height", "1.4");

  let html = `<div style="font-weight: bold; margin-bottom: 4px;">${d.outcome}`;
  if (d.type === 'group') {
    html += ` - ${d.group}`;
  }
  html += `</div>`;

  html += `<div>Count: ${d.count}</div>`;

  if (d.type === 'overall') {
    // Show per-group breakdown of this outcome
    html += `<div style="margin-top: 6px; font-weight: bold;">Group shares:</div>`;
    const outcomeTotal = barData.outcomeTotals[d.outcome];
    barData.groupNames.forEach(g => {
      const groupCount = barData.confusionCounts[g][d.outcome];
      if (groupCount > 0) {
        const pct = ((groupCount / outcomeTotal) * 100).toFixed(1);
        html += `<div>${g}: ${pct}%</div>`;
      }
    });
  } else if (d.type === 'group') {
    // Show both interpretations
    const groupTotal = barData.groupTotals[d.group];
    const outcomeTotal = barData.outcomeTotals[d.outcome];
    const groupPct = ((d.count / groupTotal) * 100).toFixed(1);
    const outcomePct = ((d.count / outcomeTotal) * 100).toFixed(1);

    html += `<div style="margin-top: 4px;">% of ${d.group}: ${groupPct}%</div>`;
    html += `<div>% of all ${d.outcome}: ${outcomePct}%</div>`;
  }

  tooltip.html(html)
    .style("left", (event.pageX + 15) + "px")
    .style("top", (event.pageY - 10) + "px")
    .style("opacity", 1);
}

function hideTooltip() {
  d3.select(".confusion-bar-tooltip")
    .style("opacity", 0)
    .remove();
}

function handleSegmentClick(event, d) {
  if (d.type === 'overall') {
    // Click on overall outcome segment: toggle outcome selection
    toggleOutcomeSelection(d.outcome);
  } else if (d.type === 'group') {
    // Click on group segment: select specific group + outcome combination
    if (event.shiftKey) {
      // Shift-click: toggle group selection only
      if (selectedGroups.has(d.group)) {
        selectedGroups.delete(d.group);
      } else {
        selectedGroups.add(d.group);
      }
    } else {
      // Regular click: toggle this specific outcome for this group
      // This creates a stream selection similar to clicking a Sankey link

      // First, clear any feature-based selections (from distribution bars)
      // Confusion bar selections take precedence
      const featureKeys = Array.from(window.streamSelections.keys()).filter(k => {
        const sel = window.streamSelections.get(k);
        return sel && sel.feature;
      });
      featureKeys.forEach(k => window.streamSelections.delete(k));

      const key = `${d.group}|${d.outcome}`;

      if (window.streamSelections.has(key)) {
        window.streamSelections.delete(key);
      } else {
        const rows = (state?.data || []).filter(r =>
          rowMatchesGroup(r, d.group) && rowOutcome(r) === d.outcome
        );
        const ids = rows.map(r => r.id ?? r._id).filter(id => id != null);
        const MAX_STREAM_ROWS = 500;
        const pick = ids.length > MAX_STREAM_ROWS
          ? d3.shuffle(ids.slice()).slice(0, MAX_STREAM_ROWS)
          : ids.slice();

        window.streamSelections.set(key, {
          group: d.group,
          outcome: d.outcome,
          ids: new Set(pick),
          color: OUTCOME_COLORS[d.outcome] || "#666"
        });
      }

      assignStreamColors();
    }
  }

  updateConfusionBarStyles();
  renderPCP();
  updateFeatureDistribution();
  renderSliceMetrics();
}

/**
 * Handle clicks on score distribution bars
 * Filters PCP to show only rows matching the selected feature bucket and group
 */
function handleDistributionBarClick(event, d) {
  if (!d.bucket || !d.group || !d.feature) return;

  // Check if there's an outcome-based selection active (from confusion bars)
  const outcomeSelections = Array.from(window.streamSelections.entries()).filter(([k, sel]) => sel.outcome);
  const hasOutcomeSelection = outcomeSelections.length > 0;

  // Extract the actual group name and outcome from d.group
  // If d.group is "≥30 → TP", extract "≥30" and "TP"
  // If d.group is just "≥30", use it as-is
  let actualGroupName = d.group;
  let outcome = null;
  if (d.group.includes(' → ')) {
    const parts = d.group.split(' → ');
    actualGroupName = parts[0];
    outcome = parts[1];
  }

  // Create a unique key for this feature bucket + group combination
  const key = `${d.group}|${d.feature}:${d.bucket.label}`;

  // Toggle: if already selected, deselect
  if (window.streamSelections.has(key)) {
    window.streamSelections.delete(key);
  } else {
    let baseRows = state?.data || [];

    // If there's an outcome-based selection, filter within that SPECIFIC outcome's subset
    if (hasOutcomeSelection && outcome) {
      // Find the specific outcome selection that matches this bar's group and outcome
      const specificOutcomeKey = `${actualGroupName}|${outcome}`;
      const specificSelection = window.streamSelections.get(specificOutcomeKey);

      if (specificSelection && specificSelection.ids) {
        // Only filter from rows in THIS SPECIFIC outcome selection
        baseRows = baseRows.filter(r => specificSelection.ids.has(r.id ?? r._id));
      }
    } else if (hasOutcomeSelection) {
      // Fallback: if no specific outcome extracted, use all outcome IDs
      const outcomeIds = new Set();
      outcomeSelections.forEach(([k, sel]) => {
        sel.ids.forEach(id => outcomeIds.add(id));
      });
      baseRows = baseRows.filter(r => outcomeIds.has(r.id ?? r._id));
    }

    // Filter rows that match this group AND have the feature value in this bucket
    const rows = baseRows.filter(r => {
      // Check if row belongs to this group (use actualGroupName for matching)
      if (!rowMatchesGroup(r, actualGroupName)) return false;

      // Check if row's feature value is in this bucket
      const featureValue = r[d.feature];
      if (featureValue == null) return false;

      return d.bucket.test(featureValue);
    });

    const ids = rows.map(r => r.id ?? r._id).filter(id => id != null);
    const MAX_STREAM_ROWS = 500;
    const pick = ids.length > MAX_STREAM_ROWS
      ? d3.shuffle(ids.slice()).slice(0, MAX_STREAM_ROWS)
      : ids.slice();

    // Use the group color for coherent visualization
    window.streamSelections.set(key, {
      group: actualGroupName,  // Store the actual group name
      displayName: d.group,     // Store the display name for legend
      feature: d.feature,
      bucket: d.bucket.label,
      outcome: outcome,         // Store the outcome if it exists
      ids: new Set(pick),
      color: d.color  // Use the same color as the bar (group color)
    });
  }

  // DON'T call assignStreamColors() for feature selections - we want to keep group colors
  // Only assign contrasting colors for outcome-based selections
  const hasOutcomeSelections = Array.from(window.streamSelections.values()).some(sel => sel.outcome && !sel.feature);
  if (hasOutcomeSelections && !Array.from(window.streamSelections.values()).some(sel => sel.feature)) {
    assignStreamColors();
  }

  // Don't update confusion bars - only update PCP
  renderPCP();
  // Re-render feature distribution to update bar highlighting
  updateFeatureDistribution();
}

function updateConfusionBarStyles() {
  if (!window._confusionBarSvg) return;

  const svg = window._confusionBarSvg;
  const hasOutcomeSelection = selectedOutcomes && selectedOutcomes.size > 0;
  const hasGroupSelection = selectedGroups && selectedGroups.size > 0;
  const hasStreamSelection = window.streamSelections && window.streamSelections.size > 0;

  // Check if we have feature-based selections (from distribution bars)
  const hasFeatureSelection = window.streamSelections &&
    Array.from(window.streamSelections.values()).some(sel => sel.feature);

  svg.selectAll(".bar-segment")
    .classed("active", function(d) {
      if (d.type === 'overall') {
        return selectedOutcomes.has(d.outcome);
      } else if (d.type === 'group') {
        const streamKey = `${d.group}|${d.outcome}`;
        return window.streamSelections?.has(streamKey) ||
               (selectedOutcomes.has(d.outcome) && selectedGroups.has(d.group));
      }
      return false;
    })
    .classed("dimmed", function(d) {
      // Don't dim bars when feature selections are active - they should just update their counts
      if (hasFeatureSelection) {
        return false;
      }

      if (!hasOutcomeSelection && !hasGroupSelection && !hasStreamSelection) {
        return false;
      }

      if (d.type === 'overall') {
        return hasOutcomeSelection && !selectedOutcomes.has(d.outcome);
      } else if (d.type === 'group') {
        const streamKey = `${d.group}|${d.outcome}`;
        const isActive = window.streamSelections?.has(streamKey) ||
                        (selectedOutcomes.has(d.outcome) && selectedGroups.has(d.group));

        if (hasStreamSelection && !window.streamSelections.has(streamKey)) {
          return true;
        }
        if (hasOutcomeSelection && !selectedOutcomes.has(d.outcome)) {
          return true;
        }
        if (hasGroupSelection && !selectedGroups.has(d.group)) {
          return true;
        }
      }

      return false;
    })
    .attr("stroke-width", function(d) {
      const isActive = d3.select(this).classed("active");
      return isActive ? 3 : 1;
    });
}

// Helper function to check if row matches a group
function rowMatchesGroup(row, groupName) {
  if (!currentProtected || !currentProtected.length) return false;

  // Parse the group name to extract feature values
  // Format examples: "age=Young", "age=Young_gender=Female", or just "Young"

  // Check if groupName contains "=" (structured format)
  if (groupName.includes("=")) {
    const parts = groupName.split("_");

    for (const part of parts) {
      const [feature, value] = part.split("=");
      if (feature && value) {
        const rowValue = String(row[feature] ?? "").trim();
        const targetValue = value.trim();
        if (rowValue !== targetValue) {
          return false;
        }
      }
    }
    return true;
  } else {
    // Simple format: just the value (e.g., "Young", "Old")
    // Match against all protected attributes
    for (const attr of currentProtected) {
      const rowValue = String(row[attr] ?? "").trim();
      if (rowValue === groupName.trim()) {
        return true;
      }
    }
    return false;
  }
}

// Update confusion bars with filtered data (e.g., from PCP brushing)
function updateConfusionBarsWithFilter(filteredRows = null) {
  // Get the last Sankey data structure
  if (!window._lastSankeyData) {
    console.warn("No Sankey data available for confusion bar update");
    return;
  }

  // Redraw confusion bars with the filtered rows
  drawConfusionBars(window._lastSankeyData, filteredRows);
}

// Export update functions for external calls
window.updateConfusionBarStyles = updateConfusionBarStyles;
window.updateConfusionBarsWithFilter = updateConfusionBarsWithFilter;


/* ========= 7. COLOR rules =============================== */
// palette for shares (0 → 1)
let linkColorMode = "none"; // "none" | "tpr" | "fpr" | "tnr" | "fnr" | "gt_comp"

const rateScale  = d3.scaleSequential(d3.interpolateBlues).domain([0, 1]); // 0..1 rates
const shareScale = d3.scaleSequential(d3.interpolateBlues).domain([0, 1]);

function linkStroke(d){
  // NEW: Neutral links (outcome transitions) get special color
  if (d.neutral) return "#999";

  const fromGT = (d.source.name === "GT+" || d.source.name === "GT-");
  const isOutcomeHover = hoverOutcome && ["TP","FP","TN","FN"].includes(hoverOutcome);
  // Color only the GT → Group streams; others stay neutral
  if (fromGT) return shareScale(d.share ?? 0);
  if (isOutcomeHover){
    if (d.target && d.target.name === hoverOutcome){
      const v = d[rateAttr[hoverOutcome]];
      return (v == null) ? "#a9a9a9" : rateScale(v);
    }
    return "#d0d0d0";   // fade others
  }
  return "#a9a9a9";
}
function linkOpacity(d){
  // NEW: Make neutralization links semi-transparent
  if (d.neutral) return 0.4;
  // 1) Outcome hover → dim *group→outcome* links that don't end at that outcome
  if (hoverOutcome) {
    if (!isFirstHop(d) && d.target.name !== hoverOutcome) return FADE_OP_OUTCOME;
    return d._baseOpacity;
  }
  // 2) GT hover → dim *first-hop* links whose source is the other GT
  if (hoverGT && isFirstHop(d)) {
    return (d.source.name === hoverGT) ? d._baseOpacity : FADE_OP_GT;
  }
  // 3) No hover → restore base
  return d._baseOpacity;
}

function metricDisplayName(m){
  const map = {
    equal_opportunity    : "Equal Opportunity — TPR",
    predictive_parity    : "Predictive Parity — PPV",
    predictive_equality  : "Predictive Equality — FPR",
    demographic_parity   : "Demographic Parity — PPR",
    equalized_odds       : "Equalized Odds",
    treatment_equality   : "Treatment Equality — FN/FP"
  };
  return map[m] || m;
}

function renderNodeLegend(){
  const wrap = d3.select("#node-legend");
  wrap.selectAll("*").remove();

  wrap.append("div")
      .attr("class", "legend-title")
      .text("Group colors (categorical)");

  if (!GROUP_COLOR_SCALE) return;

  const names = GROUP_COLOR_SCALE.domain();
  const itemH = 16, gap = 6, w = 240, h = names.length*(itemH+gap) + 6;

  const svg = wrap.append("svg")
    .attr("width", w)
    .attr("height", h);

  const g = svg.append("g").attr("transform","translate(6,6)");

  const row = g.selectAll("g.item")
    .data(names)
    .join("g")
      .attr("class","item")
      .attr("transform",(d,i)=>`translate(0,${i*(itemH+gap)})`);

  row.append("rect")
    .attr("x",0).attr("y",0)
    .attr("width",12).attr("height",12).attr("rx",2)
    .attr("fill", d => GROUP_COLOR_SCALE(d))
    .attr("stroke","#333").attr("stroke-width",0.4);

  row.append("text")
    .attr("x", 18).attr("y", 10)
    .style("font-size","11px")
    .text(d => d);
}

function renderNumDenLegend(){
  const el = d3.select("#numden-legend");   // add <div id="numden-legend"></div> in HTML
  el.selectAll("*").remove();

  const items = [
    {label: "Numerator",   color: NUM_NODE_COLOR},
    {label: "Denominator", color: DEN_NODE_COLOR},
    {label: "Other outcome", color: OTHER_NODE_COLOR},
    {label: "GT+/GT−", color: GT_NODE_COLOR}
  ];

  const w = 220, h = 14 * items.length + 8;
  const svg = el.append("svg").attr("width", w).attr("height", h);
  const g = svg.append("g").attr("transform","translate(4,6)");

  const row = g.selectAll("g.item")
    .data(items)
    .join("g")
      .attr("class","item")
      .attr("transform",(d,i)=>`translate(0,${i*14})`);

  row.append("rect")
     .attr("width",12).attr("height",12).attr("rx",2)
     .attr("fill", d => d.color).attr("stroke","#333").attr("stroke-width",0.4);

  row.append("text")
     .attr("x",18).attr("y",10).style("font-size","11px")
     .text(d => d.label);
}

function nodeColor(node){
  const isGT = (node.name === "GT+" || node.name === "GT-");
  const isOutcome = ["TP","FP","TN","FN"].includes(node.name);
  if (node.name === "GT+") return GT_POS_COLOR;
  if (node.name === "GT-") return GT_NEG_COLOR;

  // Middle-column protected-group nodes: categorical palette
  if (!isGT && !isOutcome) {
    return GROUP_COLOR_SCALE ? GROUP_COLOR_SCALE(node.name) : "#bbb";
  }

  // GT nodes: neutral
  if (isGT) return GT_NODE_COLOR;

  // Outcome nodes: color by role for the current metric
  const role = nodeRole(node);  // "num" | "den" | "other"
  if (role === "num") return NUM_NODE_COLOR;
  if (role === "den") return DEN_NODE_COLOR;
  return OTHER_NODE_COLOR;
}
function linkWidth(d){
  // Store the normalized width on the datum during initial render
  if (d._normalizedWidth !== undefined) {
    return Math.max(1, d._normalizedWidth);
  }

  const fromGroupCol = (window._kGroup && d.source.depth === window._groupDepth && OUTS.has(d.target.name));
  if (fromGroupCol) {
    const normalized = Math.max(1, window._kGroup * d.value);
    d._normalizedWidth = normalized;  // Cache it
    return normalized;
  }
  
  // fallback to sankey's native width for other hops
  return Math.max(1, d.width);
}

function nodeRole(node){
  const num   = metricNumerator(currentMetric);     // e.g. ["TP"]
  const denom = metricDenominator(currentMetric);   // e.g. ["TP","FN"]
  const inNum   = Array.isArray(num)   ? num.includes(node.name)   : node.name === num;
  const inDenom = denom.includes(node.name);
  return inNum ? "num" : (inDenom ? "den" : "other");
}

/* ========= 8. Metric lookup tables ======================= */
function metricNumerator(metric) {
  switch (metric) {
    case "equal_opportunity":   return ["TP"];                 // TPR
    case "predictive_parity":   return ["TP"];                 // Precision
    case "predictive_equality": return ["FP"];                 // FPR
    case "equalized_odds":      return ["TP", "FP"];           // TPR + FPR numerators
    case "demographic_parity":  return ["TP", "FP"];           // Predicted positives
    case "treatment_equality":  return ["FN"];                 // FN / FP
    default:                    return ["TP"];
  }
}
function metricDenominator(metric) {
  switch (metric) {
    case "equal_opportunity":   return ["TP", "FN"];           // GT+
    case "predictive_parity":   return ["TP", "FP"];           // Pred+
    case "predictive_equality": return ["FP", "TN"];           // GT−
    case "equalized_odds":      return ["TP", "FN", "FP", "TN"];
    case "demographic_parity":  return ["TP", "FP", "TN", "FN"];           // Pred+
    case "treatment_equality":  return ["FP"];                 // FN / FP
    default:                    return ["TP", "FN"];
  }
}

function toggleEOSelector() {
  const show = currentMetric === "equalized_odds";
  d3.select("#eo-component").style("display", show ? "inline-block" : "none");
}

/* ========= 9. First paint ================================= */
(async () => {
  /* ② first paint */
  d3.selectAll("#metric-options input[type=radio]")
    .on("change", async function () {
      currentMetric = this.id;
      updateMetricEquation();         // NEW
      await updateAll();
  });
  await updateAll();      // draws Sankey + gap
  renderBaselineGapsSummary();

})();

/* ========= 10. Link legend ================================= */
function legendLabel() {
  if (!hoverOutcome) return "Link color = GT share (0 → 1)";
  const map = {TP:"Link color = TPR (0 → 1)",
               FP:"Link color = FPR (0 → 1)",
               TN:"Link color = TNR (0 → 1)",
               FN:"Link color = FNR (0 → 1)"};
  return map[hoverOutcome] || "Link color";
}

function outcomeCaption(){
  const m = { TP:"TPR", FP:"FPR", TN:"TNR", FN:"FNR" };
  return m[hoverOutcome] || "GT share";
}

function updateLinkLegend(){
  // No longer needed for confusion bar visualization
  const el = d3.select("#link-legend");
  el.selectAll("*").remove();
  return; // Early return - don't render link legend

  // OLD CODE (kept for reference if reverting to Sankey)
  const w = 240, h = 12;
  const pad = { l: 8, r: 8, t: 4, b: 22 };

  // Title as HTML (outside SVG)
  el.append("div")
    .attr("class", "legend-title")
    .text(`Link color = ${outcomeCaption()} (0 \u2192 1)`);

  const svg = el.append("svg")
    .attr("width",  w + pad.l + pad.r)
    .attr("height", h + pad.t + pad.b);

  // Gradient
  const gradId = "linkGrad-" + (hoverOutcome || "gt");
  const defs = svg.append("defs");
  const grad = defs.append("linearGradient")
    .attr("id", gradId).attr("x1","0%").attr("x2","100%")
    .attr("y1","0%").attr("y2","0%");

  const palette = hoverOutcome ? rateScale : shareScale;
  [0, 0.25, 0.5, 0.75, 1].forEach(t => {
    grad.append("stop")
        .attr("offset", (t*100) + "%")
        .attr("stop-color", palette(t));
  });

  svg.append("rect")
     .attr("x", pad.l).attr("y", pad.t)
     .attr("width", w).attr("height", h)
     .attr("stroke", "#aaa")
     .style("fill", `url(#${gradId})`);

  // Ticks 0, .5, 1
  const baseY = pad.t + h;
  [[0,"0"], [0.5,"0.5"], [1,"1"]].forEach(([t,lab])=>{
    const x = pad.l + t*w;
    svg.append("line")
       .attr("x1",x).attr("x2",x)
       .attr("y1",baseY).attr("y2",baseY+4)
       .attr("stroke","#666");
    svg.append("text")
       .attr("x",x).attr("y",baseY+14)
       .attr("text-anchor", t===0 ? "start" : t===1 ? "end" : "middle")
       .attr("font-size","10px").text(lab);
  });
}

/*--------------------------------PCP----------------------------------------------------------------*/
// absolute Pearson correlation with the binary target
function absPearson(x, y) {
  const n = Math.min(x.length, y.length);
  let mx=0, my=0, vx=0, vy=0, c=0, k=0;
  for (let i=0;i<n;i++){
    const xi = +x[i], yi = +y[i];
    if (Number.isFinite(xi) && Number.isFinite(yi)) {
      k++; mx+=xi; my+=yi;
    }
  }
  if (!k) return 0;
  mx/=k; my/=k;
  for (let i=0;i<n;i++){
    const xi = +x[i], yi = +y[i];
    if (Number.isFinite(xi) && Number.isFinite(yi)) {
      const dx = xi-mx, dy = yi-my;
      vx += dx*dx; vy += dy*dy; c  += dx*dy;
    }
  }
  return (vx && vy) ? Math.abs(c / Math.sqrt(vx*vy)) : 0;
}

// Cramér's V for (feature levels × binary target)
function cramersVForBinary(data, col, targetKey='true_label'){
  const levs = Array.from(new Set(data.map(d => d[col]))); if (!levs.length) return 0;
  const n = data.length;
  let n1=0, n0=0; data.forEach(d => +d[targetKey] ? n1++ : n0++);
  let chi2 = 0;
  for (const L of levs){
    let a=0,b=0; // target 0/1 within this level
    data.forEach(d => { if (d[col] === L) (+d[targetKey] ? b++ : a++); });
    const r = a+b;
    const e0 = r*(n0/n) || 1e-9, e1 = r*(n1/n) || 1e-9;
    chi2 += (a-e0)*(a-e0)/e0 + (b-e1)*(b-e1)/e1;
  }
  // 2 columns → min(k-1, 1) = 1
  return Math.sqrt(chi2/(n*1));
}

// order by association with *true_label* (change to 'prediction' if you prefer)
function computePcpOrder(){
  const tgt = state.data.map(d => +d.true_label);
  const ignore = new Set([...PCP_HIDE, "true_label", "prediction"]);// keep "score" if you like

  const score = {};
  const numCols = state.numericKeys.filter(k => !ignore.has(k));
  const catCols = state.catKeys.filter(k => !ignore.has(k));

  numCols.forEach(col => {
    score[col] = absPearson(state.data.map(d => +d[col]), tgt);
  });
  catCols.forEach(col => {
    score[col] = cramersVForBinary(state.data, col, "true_label");
  });

  return Object.keys(score).sort((a,b) => d3.descending(score[a], score[b]));
}


// Normalise text for robust matching (case-insensitive, strip punctuation)
function _norm(s){
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}
// --- helpers: resolve PCP columns & parse numeric ranges in labels ---
function resolvePcpKeys() {
  const all = [...state.numericKeys, ...state.catKeys];
  const normMap = new Map(all.map(c => [_norm(c), c])); // "age" -> "Age"
  return currentProtected.map(k => normMap.get(_norm(k)) || k);
}
// Parse a numeric condition embedded anywhere in a label.
// Supports: [a,b), (a,b], a-b (inclusive), <, <=, >, >=, "under 30", "over 50", "50+"
function parseNumericPredicate(label){
  const s = String(label).toLowerCase();

  // 1) bracketed intervals: [a,b), (a,b], etc.
  let m = s.match(/([\[\(])\s*(-?\d*\.?\d+)\s*[,–-]\s*(-?\d*\.?\d+)\s*([\]\)])/);
  if (m){
    const lo = +m[2], hi = +m[3];
    const lc = m[1] === '[';      // left closed
    const rc = m[4] === ']';      // right closed
    return x => (lc ? x >= lo : x > lo) && (rc ? x <= hi : x < hi);
  }

  // 2) hyphen/en dash range: "30-49" or "30–49" (assume inclusive)
  m = s.match(/(-?\d*\.?\d+)\s*[–-]\s*(-?\d*\.?\d+)/);
  if (m){
    const lo = +m[1], hi = +m[2];
    return x => x >= lo && x <= hi;
  }

  // 3) inequalities: <, <=, >, >=, ≤, ≥
  m = s.match(/(<=|>=|<|>|≤|≥)\s*(-?\d*\.?\d+)/);
  if (m){
    const op = m[1], v = +m[2];
    return x =>
      op === '<'  ? x <  v :
      op === '<=' || op === '≤' ? x <= v :
      op === '>'  ? x >  v :
      /* >= or ≥ */             x >= v;
  }

  // 4) words: "under 30", "less than 30", "below 30"
  m = s.match(/\b(under|less\s+than|below)\s*(-?\d*\.?\d+)/);
  if (m){
    const v = +m[2];
    return x => x < v;
  }
  // 5) words: "over 50", "above 50", "at least 50"
  m = s.match(/\b(over|above)\s*(-?\d*\.?\d+)/);
  if (m){
    const v = +m[2];
    return x => x > v;
  }
  m = s.match(/\b(at\s+least)\s*(-?\d*\.?\d+)/);
  if (m){
    const v = +m[2];
    return x => x >= v;
  }

  // 6) "50+" etc.
  m = s.match(/(-?\d*\.?\d+)\s*\+/);
  if (m){
    const v = +m[1];
    return x => x >= v;
  }

  return null; // no numeric condition found
}

// Does a data row belong to the Sankey group label `gname`?
// Rule: For each protected feature currently in use, the row's value
// must appear (normalised) somewhere in the group node's label.
function rowMatchesGroup(row, gname){
  const G = _norm(gname);
  const cols = resolvePcpKeys(); // e.g. ["Age", "PersonalStatusSex"]

  return cols.every(col => {
    const v = row[col];
    if (v == null) return false;

    // numeric column/value? use numeric predicate if we can extract one
    const isNumericCol = state.numericKeys.includes(col);
    const num = +v;
    if (isNumericCol && Number.isFinite(num)) {
      const pred = parseNumericPredicate(gname);
      if (pred) return pred(num);
      // if label had no numeric rule, fall back to string match
    }
    // helper once near the top (or inside rowMatchesGroup)
    function _labelTokens(s){
      return new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    }

    // inside rowMatchesGroup(...)
    const tokens = _labelTokens(gname);
    const vnorm  = String(v).toLowerCase();
    return tokens.has(vnorm);

  });
}

// OR across all selected groups
function rowMatchesAnySelectedGroup(row){
  if (selectedGroups.size === 0) return true;

  // if user effectively selected "everything", don't filter
  if (window.ALL_GROUP_NODE_NAMES &&
      selectedGroups.size >= window.ALL_GROUP_NODE_NAMES.size) {
    return true;
  }

  for (const g of selectedGroups){
    if (rowMatchesGroup(row, g)) return true;
  }
  return false;
}
// If groups are selected, return the *first* matching group's name for this row
// (used for coloring). Returns null if no match.
function firstMatchingGroup(row){
  for (const g of selectedGroups){
    if (rowMatchesGroup(row, g)) return g;
  }
  return null;
}
// ---- Type helpers ----
function isNumericCol(col){ return new Set(state.numericKeys).has(col); }

// Robust, pairwise Pearson |r| for two numeric columns
function absPearsonCols(colA, colB){
  const n = state.data.length;
  let sx=0, sy=0, sxx=0, syy=0, sxy=0, k=0;
  for (let i=0;i<n;i++){
    const ax = +state.data[i][colA];
    const by = +state.data[i][colB];
    if (Number.isFinite(ax) && Number.isFinite(by)){
      k++; sx+=ax; sy+=by;
      sxx+=ax*ax; syy+=by*by; sxy+=ax*by;
    }
  }
  if (k < 2) return 0;
  const cov = sxy - (sx*sy)/k;
  const vx  = sxx - (sx*sx)/k;
  const vy  = syy - (sy*sy)/k;
  if (vx<=0 || vy<=0) return 0;
  return Math.abs(cov / Math.sqrt(vx*vy));
}

// General Cramér’s V for two categorical columns
function cramersV(colA, colB){
  const n = state.data.length;
  const A = new Map(), B = new Map();
  // index categories
  let ia=0, ib=0;
  for (const row of state.data){
    const a = row[colA], b = row[colB];
    if (a==null || b==null) continue;
    if (!A.has(a)) A.set(a, ia++);
    if (!B.has(b)) B.set(b, ib++);
  }
  const r = A.size, c = B.size;
  if (r<2 || c<2) return 0;

  // contingency
  const M = Array.from({length:r}, ()=>Array(c).fill(0));
  let N = 0;
  for (const row of state.data){
    const a = row[colA], b = row[colB];
    if (!A.has(a) || !B.has(b)) continue;
    M[A.get(a)][B.get(b)]++; N++;
  }
  if (N === 0) return 0;

  // chi^2
  const rowSum = M.map(row => row.reduce((s,v)=>s+v,0));
  const colSum = Array(c).fill(0);
  for (let j=0;j<c;j++) for (let i=0;i<r;i++) colSum[j]+=M[i][j];

  let chi2 = 0;
  for (let i=0;i<r;i++){
    for (let j=0;j<c;j++){
      const E = (rowSum[i]*colSum[j])/N || 1e-12;
      const diff = M[i][j]-E;
      chi2 += (diff*diff)/E;
    }
  }
  const k = Math.min(r, c) - 1;
  if (k <= 0) return 0;
  const V = Math.sqrt(chi2 / (N * k));
  return Math.min(1, V);
}

// Correlation ratio η (numeric explained by categorical)
function correlationRatio(catCol, numCol){
  // collect groups
  const groups = new Map();
  let N = 0, sum = 0, sumsq = 0;
  for (const row of state.data){
    const g = row[catCol];
    const x = +row[numCol];
    if (g==null || !Number.isFinite(x)) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(x);
    N++; sum+=x; sumsq+=x*x;
  }
  if (N < 2 || groups.size < 2) return 0;

  const mean = sum/N;
  const ssTot = sumsq - N*mean*mean;
  if (ssTot <= 0) return 0;

  let ssBetween = 0;
  for (const arr of groups.values()){
    const n = arr.length;
    if (n === 0) continue;
    const m = arr.reduce((s,v)=>s+v,0)/n;
    ssBetween += n * (m-mean)*(m-mean);
  }
  const eta2 = ssBetween / ssTot;
  return Math.sqrt(Math.max(0, Math.min(1, eta2)));
}

// Pairwise similarity in [0,1] between two dimensions
function dimSimilarity(a, b){
  const aNum = isNumericCol(a), bNum = isNumericCol(b);
  if (aNum && bNum) return absPearsonCols(a,b) || 0;
  if (!aNum && !bNum) return cramersV(a,b) || 0;
  // mixed
  return aNum ? correlationRatio(b, a) : correlationRatio(a, b);
}
function computePcpOrderTSP(){
  const HIDE = (typeof PCP_HIDE !== 'undefined') ? PCP_HIDE : new Set();
  const allDims = [...state.numericKeys, ...state.catKeys].filter(d => !HIDE.has(d));
  if (allDims.length <= 2) return allDims.slice();

  // Build distance matrix: d = 1 - sim
  const n = allDims.length;
  const idx = new Map(allDims.map((d,i)=>[d,i]));
  const dist = Array.from({length:n}, ()=>Array(n).fill(0));
  for (let i=0;i<n;i++){
    for (let j=i+1;j<n;j++){
      const s = dimSimilarity(allDims[i], allDims[j]) || 0;
      const d = 1 - Math.max(0, Math.min(1, s));
      dist[i][j] = dist[j][i] = d;
    }
  }

  // Start at the most “central” dimension (max avg similarity = min avg distance)
  let start = 0, bestAvg = Infinity;
  for (let i=0;i<n;i++){
    const avgD = d3.mean(dist[i]);
    if (avgD < bestAvg){ bestAvg = avgD; start = i; }
  }

  // Nearest neighbor tour
  const used = Array(n).fill(false);
  let cur = start;
  used[cur] = true;
  const tour = [cur];
  for (let step=1; step<n; step++){
    let best=-1, bestD=Infinity;
    for (let j=0;j<n;j++){
      if (used[j]) continue;
      const dj = dist[cur][j];
      if (dj < bestD){ bestD=dj; best=j; }
    }
    used[best] = true;
    tour.push(best);
    cur = best;
  }

  // 2-opt on the *cycle* (tour + return to start)
  function tourLength(t){
    let L = dist[t[n-1]][t[0]];
    for (let i=0;i<n-1;i++) L += dist[t[i]][t[i+1]];
    return L;
  }
  function twoOptOnce(t){
    let improved = false;
    for (let i=0;i<n-2;i++){
      for (let k=i+2;k<n-(i===0?1:0);k++){ // avoid breaking the implicit start edge twice
        const a=t[i], b=t[(i+1)%n], c=t[k], d=t[(k+1)%n];
        const delta = (dist[a][c]+dist[b][d]) - (dist[a][b]+dist[c][d]);
        if (delta < -1e-9){
          // reverse segment (i+1..k)
          const seg = t.slice(i+1, k+1).reverse();
          t.splice(i+1, seg.length, ...seg);
          improved = true;
        }
      }
    }
    return improved;
  }
  for (let it=0; it<8; it++){
    if (!twoOptOnce(tour)) break;
  }

  // Break the worst edge to form a path
  let worstIdx = 0, worstD = -1;
  for (let i=0;i<n;i++){
    const j = (i+1)%n;
    const dj = dist[tour[i]][tour[j]];
    if (dj > worstD){ worstD = dj; worstIdx = i; }
  }
  const pathIdxs = tour.slice(worstIdx+1).concat(tour.slice(0,worstIdx+1));
  return pathIdxs.map(i => allDims[i]);
}

function onSankeyNodeClick(node) {
  const gid = node.id; // or node.name/groupKey
  if (selectionMode === 'context') {
    (contextGroupIds.has(gid) ? contextGroupIds.delete(gid) : contextGroupIds.add(gid));
  } else { // 'stream'
    // Add all rows belonging to this group as streams
    data.forEach(d => { if (d.groupId === gid) streamRowIds.add(d.id); });
  }
  renderPCP();
}

// ----------------Computing per-group bands--------------------------------------
function quantile(arr, q) {
  if (!arr.length) return NaN;
  const a = arr.slice().sort((a,b)=>a-b);
  const i = (a.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? a[lo] : a[lo] + (a[hi]-a[lo])*(i-lo);
}

// Build a continuous envelope (q_lo..q_hi) across all axes for ONE group
function computeContextBandForGroup(groupId, dims, yScales, rowsByGroup) {
  const rows = rowsByGroup.get(groupId) || [];
  if (!rows.length) return null;

  // For each axis, collect values for this group, compute quantiles, map to pixels
  const points = dims.map(dim => {
    const vals = rows.map(r => r[dim]).filter(v => v != null && !Number.isNaN(v));
    if (!vals.length) return { dim, yLo: NaN, yHi: NaN };
    const qLo = quantile(vals, CONTEXT_Q_LO);
    const qHi = quantile(vals, CONTEXT_Q_HI);
    return {
      dim,
      yLo: yScales[dim](qHi), // note: y-scale is inverted; higher value → smaller pixel y
      yHi: yScales[dim](qLo)
    };
  });
  return points;
}

// Pre-index your data by group once
function indexRowsByGroup(data) {
  const m = new Map();
  for (const d of data) {
    const g = d.groupId; // adapt to your group key
    if (!m.has(g)) m.set(g, []);
    m.get(g).push(d);
  }
  return m;
}

function buildPcpFeatureControls() {
  const host = d3.select("#pcp-feature-list");
  if (host.empty()) return;

  const allFeatures = [...state.numericKeys, ...state.catKeys]
    .filter(k => !PCP_HIDE.has(k));

  // Initialize whitelist to "all on" the first time (or when features change)
  const initial = new Set(allFeatures);
  if (!window.pcpFeatureWhitelist) window.pcpFeatureWhitelist = initial;

  // Rebuild the list
  host.selectAll("*").remove();

  const rows = host.selectAll("label.pcp-feat")
    .data(allFeatures)
    .join("label")
      .attr("class", "pcp-feat")
      .style("display","flex")
      .style("align-items","center")
      .style("gap","6px")
      .style("margin","4px 0");

  rows.append("input")
      .attr("type","checkbox")
      .attr("value", d => d)
      .property("checked", d => window.pcpFeatureWhitelist.has(d))
      .on("change", function(_, d) {
        if (this.checked) window.pcpFeatureWhitelist.add(d);
        else window.pcpFeatureWhitelist.delete(d);
        renderPCP();
      });

  rows.append("span")
      .text(d => friendly(d));

  // Buttons
  d3.select("#pcp-feat-all").on("click", () => {
    window.pcpFeatureWhitelist = new Set(allFeatures);
    host.selectAll("input[type=checkbox]").property("checked", true);
    renderPCP();
  });
  d3.select("#pcp-feat-none").on("click", () => {
    window.pcpFeatureWhitelist.clear();
    host.selectAll("input[type=checkbox]").property("checked", false);
    renderPCP();
  });
}



/**
 * Render mini distribution bar charts on PCP axis
 * Shows percentage distribution across selected groups
 */
function renderAxisDistribution(axisGroup, feature, yScale, isNumeric, axisHeight) {
  // Get group data
  const { groups, allData } = getDistributionData();

  if (!groups.length || !allData.length) {
    console.log(`No groups for feature ${feature}:`, groups.length, 'groups', allData.length, 'rows');
    return;
  }

  const maxBarWidth = 100; // Maximum width for bars extending from axis

  // Create tooltip for this axis
  const tooltip = createStyledTooltip(`pcp-axis-tooltip-${feature}`);

  if (isNumeric) {
    // For numeric features: use tick positions
    const ticks = yScale.ticks ? yScale.ticks(4) : yScale.domain();
    console.log(`${feature} (numeric) ticks:`, ticks.length);

    for (let i = 0; i < ticks.length - 1; i++) {
      const binMin = ticks[i];
      const binMax = ticks[i + 1];

      const groupPercentages = groups.map(g => {
        const groupVals = g.data.map(r => +r[feature]).filter(v => !isNaN(v));
        const inBin = groupVals.filter(v => v >= binMin && v < binMax).length;
        return {
          group: g.name,
          color: g.color,
          pct: groupVals.length ? (inBin / groupVals.length) * 100 : 0
        };
      });

      const y1 = yScale(binMax);
      const y2 = yScale(binMin);
      const centerY = (y1 + y2) / 2;
      const barHeight = Math.abs(y2 - y1) * 0.7;

      // Draw bars for each group stacked vertically within this bin
      groupPercentages.forEach((gp, gi) => {
        const barWidth = (gp.pct / 100) * maxBarWidth;
        const barY = centerY - barHeight / 2 + (gi * barHeight / groups.length);
        const barH = barHeight / groups.length * 0.9;

        axisGroup.append("rect")
          .attr("x", 5)
          .attr("y", barY)
          .attr("width", barWidth)
          .attr("height", barH)
          .attr("fill", gp.color)
          .attr("opacity", 0.8)
          .attr("stroke", "#fff")
          .attr("stroke-width", 0.5)
          .on("mouseover", function(event) {
            const html = `<div style="font-weight: bold; margin-bottom: 4px;">${gp.group}</div>` +
                         `<div>Range: [${binMin.toFixed(1)}, ${binMax.toFixed(1)})</div>` +
                         `<div>Percentage: ${gp.pct.toFixed(1)}%</div>`;
            showStyledTooltip(tooltip, html, event);
          })
          .on("mousemove", function(event) {
            tooltip
              .style("left", (event.pageX + 10) + "px")
              .style("top", (event.pageY - 10) + "px");
          })
          .on("mouseout", function() {
            hideStyledTooltip(tooltip);
          });
      });
    }

  } else {
    // For categorical features
    const domain = yScale.domain();
    const displayCats = domain.slice(0, 15);

    // Calculate spacing between categories
    const yPositions = displayCats.map(c => yScale(c)).filter(y => y != null);
    let categorySpacing = 20; // Default
    if (yPositions.length > 1) {
      const diffs = [];
      for (let i = 1; i < yPositions.length; i++) {
        diffs.push(Math.abs(yPositions[i] - yPositions[i-1]));
      }
      categorySpacing = Math.min(...diffs);
    }

    const barHeight = categorySpacing * 0.6; // Use 60% of spacing for bars

    displayCats.forEach(cat => {
      const groupPercentages = groups.map(g => {
        const groupVals = g.data.map(r => String(r[feature]));
        const inCat = groupVals.filter(v => v === cat).length;
        const pct = groupVals.length ? (inCat / groupVals.length) * 100 : 0;
        return {
          group: g.name,
          color: g.color,
          pct: pct
        };
      });

      const yPos = yScale(cat);
      if (yPos == null) return; // Skip if no position

      // Draw bars for each group stacked vertically
      groupPercentages.forEach((gp, gi) => {
        const barWidth = (gp.pct / 100) * maxBarWidth;
        const barY = yPos - barHeight / 2 + (gi * barHeight / groups.length);
        const barH = barHeight / groups.length * 0.9;

        if (barWidth > 0.5) {  // Only draw if there's something visible to show
          axisGroup.append("rect")
            .attr("x", 5)
            .attr("y", barY)
            .attr("width", barWidth)
            .attr("height", barH)
            .attr("fill", gp.color)
            .attr("opacity", 0.8)
            .attr("stroke", "#fff")
            .attr("stroke-width", 0.5)
            .on("mouseover", function(event) {
              const html = `<div style="font-weight: bold; margin-bottom: 4px;">${gp.group}</div>` +
                           `<div>Category: ${cat}</div>` +
                           `<div>Percentage: ${gp.pct.toFixed(1)}%</div>`;
              showStyledTooltip(tooltip, html, event);
            })
            .on("mousemove", function(event) {
              tooltip
                .style("left", (event.pageX + 10) + "px")
                .style("top", (event.pageY - 10) + "px");
            })
            .on("mouseout", function() {
              hideStyledTooltip(tooltip);
            });
        }
      });
    });
  }
}

function renderPCP(){
  const wrap = d3.select('#pcp');
  if (wrap.empty() || !state.data.length) return;
  wrap.selectAll('*').remove();

  // Create a container row for both legend and reset button
  const topRow = wrap.append("div")
    .style("display", "flex")
    .style("justify-content", "space-between")
    .style("align-items", "flex-start")
    .style("margin-bottom", "4px")
    .style("gap", "8px");

  // Stream selection legend (shows when selections are active)
  const hasStreamSelections = window.streamSelections && window.streamSelections.size > 0;

  // Group legend (shows when no stream selections and groups exist)
  const legendGroups = (window.LAST_GROUP_NAMES || []).slice();
  const showGroupLegend = !hasStreamSelections && legendGroups.length > 0 && typeof GROUP_COLOR_SCALE === 'function';

  if (hasStreamSelections) {
    const legendBox = topRow.append("div")
      .attr("class", "pcp-stream-legend")
      .style("flex", "1 1 auto")
      .style("max-width", "calc(100% - 100px)")
      .style("padding", "3px 6px")
      .style("background", "#f9f9f9")
      .style("border", "1px solid #ddd")
      .style("border-radius", "3px")
      .style("font-size", "10px")
      .style("overflow", "hidden");

    const itemsContainer = legendBox.append("div")
      .style("display", "flex")
      .style("flex-wrap", "wrap")
      .style("gap", "6px");

    Array.from(window.streamSelections.entries()).forEach(([key, sel]) => {
      const item = itemsContainer.append("div")
        .style("display", "flex")
        .style("align-items", "center")
        .style("gap", "3px")
        .style("white-space", "nowrap");

      item.append("span")
        .style("width", "10px")
        .style("height", "8px")
        .style("background", sel.color)
        .style("border", "1px solid #333")
        .style("border-radius", "1px")
        .style("display", "inline-block")
        .style("flex-shrink", "0");

      item.append("span")
        .style("color", "#333")
        .style("font-size", "9px")
        .text(() => {
          // Check if this is a feature-based selection or outcome-based selection
          if (sel.feature && sel.bucket) {
            // Use displayName if available (for when filtering within outcome selections)
            const groupLabel = sel.displayName || sel.group;
            return `${groupLabel}: ${sel.feature}=${sel.bucket} (n=${sel.ids.size})`;
          } else if (sel.outcome) {
            return `${sel.group} → ${sel.outcome} (n=${sel.ids.size})`;
          } else {
            return `${sel.group} (n=${sel.ids.size})`;
          }
        });
    });
  } else if (showGroupLegend) {
    // Show group color legend in the same space
    const legendBox = topRow.append("div")
      .attr("class", "pcp-group-legend")
      .style("flex", "1 1 auto")
      .style("max-width", "calc(100% - 100px)")
      .style("padding", "3px 6px")
      .style("background", "#f9f9f9")
      .style("border", "1px solid #ddd")
      .style("border-radius", "3px")
      .style("font-size", "10px")
      .style("overflow", "hidden");

    const itemsContainer = legendBox.append("div")
      .style("display", "flex")
      .style("flex-wrap", "wrap")
      .style("gap", "6px");

    legendGroups.forEach((group) => {
      const item = itemsContainer.append("div")
        .style("display", "flex")
        .style("align-items", "center")
        .style("gap", "3px")
        .style("white-space", "nowrap");

      item.append("span")
        .style("width", "10px")
        .style("height", "8px")
        .style("background", GROUP_COLOR_SCALE(group))
        .style("border", "1px solid #333")
        .style("border-radius", "1px")
        .style("display", "inline-block")
        .style("flex-shrink", "0");

      item.append("span")
        .style("color", "#333")
        .style("font-size", "9px")
        .text(group);
    });
  } else {
    // Add empty spacer when no legend
    topRow.append("div").style("flex", "1");
  }

  // Buttons (always in the same row)
  const btnWrap = topRow.append("div")
    .style("flex", "0 0 auto")
    .style("display", "flex")
    .style("gap", "4px");

  // Summarize toggle button
  if (!window.pcpSummarizeMode) window.pcpSummarizeMode = false;

  btnWrap.append("button")
    .attr("id", "pcp-summarize-toggle")
    .text(window.pcpSummarizeMode ? "Hide Summary" : "Summarize")
    .style("font-size", "11px")
    .style("padding", "4px 10px")
    .style("border-radius", "3px")
    .style("border", "1px solid #999")
    .style("background", window.pcpSummarizeMode ? "#e3f2fd" : "#fff")
    .style("cursor", "pointer")
    .on("click", () => {
      window.pcpSummarizeMode = !window.pcpSummarizeMode;
      renderPCP();
    });

  // Reset button
  btnWrap.append("button")
    .attr("id", "pcp-reset-brushes")
    .html("&#x21BB;") // Clockwise open circle arrow (reset icon)
    .attr("title", "Reset filters") // Tooltip on hover
    .style("font-size", "18px")
    .style("padding", "2px 8px")
    .style("border-radius", "3px")
    .style("border", "1px solid #999")
    .style("background", "#fff")
    .style("cursor", "pointer")
    .style("line-height", "1")
    .on("click", resetPcpFilters);

  ensureSlicePanel();
  state.data.forEach((d,i) => { if (d._id == null) d._id = i; });

  const Q_LO = 0.10, Q_HI = 0.90;
  const CONTEXT_FILL_OPACITY   = 0.40;
  const CONTEXT_STROKE_OPACITY = 0.50;
  const CONTEXT_FILL_COLOR     = '#bdbdbd'; // light grey
  const CONTEXT_STROKE_COLOR   = '#8c8c8c'; // darker grey

  function quantile(arr, q){
    if (!arr || !arr.length) return NaN;
    const a = arr.slice().sort((x,y)=>x-y);
    const i = (a.length-1)*q, lo = Math.floor(i), hi = Math.ceil(i);
    return (lo===hi) ? a[lo] : a[lo] + (a[hi]-a[lo])*(i-lo);
  }
  function findAnyMatchingGroup(row){
    const names = (window.LAST_GROUP_NAMES || []);
    for (const g of names){
      if (rowMatchesGroup(row, g)) return g;
    }
    return null;
  }
  function groupOf(row){
    if (row.groupId != null) return row.groupId;
    if (row.group   != null) return row.group;
    
    // 1) If groups are explicitly selected, match only against those
    if (typeof firstMatchingGroup === 'function' && selectedGroups && selectedGroups.size > 0) {
      const gSel = firstMatchingGroup(row);
      if (gSel) return gSel;
    }
    
    // 2) NEW: On initial load (no selections), match against ALL Sankey group node labels
    const gAny = findAnyMatchingGroup(row);
    if (gAny) return gAny;
    
    return null;
  }
  function colorForGroup(g) {
    // Guard clause: Check preconditions
    if (typeof GROUP_COLOR_SCALE !== 'function') {
      console.warn('GROUP_COLOR_SCALE not initialized');
      return '#999';  // Fallback: grey
    }
    
    if (!g) {
      return '#999';  // Fallback: grey if no group name
    }
    
    // Now we know both exist, proceed safely
    return GROUP_COLOR_SCALE(g);
  }
  const ro = (typeof rowOutcome === 'function') ? rowOutcome : (r => {
    const y=+r.true_label, p=+r.prediction;
    if (y===1 && p===1) return 'TP';
    if (y===0 && p===1) return 'FP';
    if (y===0 && p===0) return 'TN';
    if (y===1 && p===0) return 'FN';
    return null;
  });

  const selOut = (typeof selectedOutcomes !== 'undefined') ? selectedOutcomes : new Set();
  const dataUniverse = state.data;
  // First filter by groups (if any)
  const byGroups = dataUniverse.filter(rowMatchesAnySelectedGroup);

  // Then, if any outcomes are selected, restrict to those outcomes
  const hasOutcomeSel = (selectedOutcomes && selectedOutcomes.size > 0);
  const dataVisible = hasOutcomeSel
    ? byGroups.filter(r => selectedOutcomes.has(rowOutcome(r)))
    : byGroups;

  if (!Array.isArray(window.pcpOrder)) window.pcpOrder = [];
  if (pcpOrder.length === 0) pcpOrder = computePcpOrderTSP();

  const hasContext = window.contextGroupIds && window.contextGroupIds.size > 0;

  // helper to count safely
  const _size = s => (s && typeof s.size === 'number') ? s.size : 0;

  // exactly one group in context (shift+click)
  const SINGLE_CONTEXT = _size(window.contextGroupIds) === 1;

  // exactly one group in simple selection (click), with no context active
  const SINGLE_CLICK   = _size(selectedGroups) === 1 && _size(window.contextGroupIds) === 0;

  // NEW: exactly one outcome selected
  const SINGLE_OUTCOME = _size(selectedOutcomes) === 1;

  // freeze axes when we have exactly one active group by either method
  const USE_INITIAL_AXES = SINGLE_CONTEXT || SINGLE_CLICK|| SINGLE_OUTCOME;



  // Axis candidates
  const HIDE = (typeof PCP_HIDE !== 'undefined') ? PCP_HIDE : new Set();
  const dimCandidates = pcpOrder.filter(d =>
    !HIDE.has(d) && (!window.pcpFeatureWhitelist || window.pcpFeatureWhitelist.has(d))
  );

  // Use full data for caching initial baseline; visible data for normal scoring
  const dataForInitial   = state.data;
  const dataForThisView  = dataVisible;

  // dimsUsed: freeze to initial when exactly one group selected OR when neutralization is active
  let dimsUsed;

  // NEW: Preserve PCP axes when neutralization is active
  if (window.NEUTRAL?.active && window.NEUTRAL?.pcpAxes?.length) {
    dimsUsed = window.NEUTRAL.pcpAxes.slice();
  } else if (USE_INITIAL_AXES && window._pcpInitial?.dimsUsed?.length) {
    dimsUsed = window._pcpInitial.dimsUsed.slice();
  } else {
    dimsUsed = pickAxes(dimCandidates, dataForThisView);

    // NEW: Store current axes before neutralization
    if (!window.NEUTRAL) window.NEUTRAL = {};
    if (!window.NEUTRAL.active) {
      window.NEUTRAL.pcpAxes = dimsUsed.slice();
    }
  }

  // Cache the initial baseline (first load: no context AND no simple selection)
  if (_size(window.contextGroupIds) === 0 && _size(selectedGroups) === 0 && _size(selectedOutcomes) === 0 && !window._pcpInitial) {
    const baselineDims = pickAxes(dimCandidates, state.data);  // full data
    window._pcpInitial = {
      dimsUsed: baselineDims.slice(),
      scores: (window._pcpSU || []).map(s => ({ ...s }))
    };
  }
  const node = wrap.node();
  const cs   = getComputedStyle(node);
  const padT = parseFloat(cs.paddingTop)    || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  const padL = parseFloat(cs.paddingLeft)   || 0;
  const padR = parseFloat(cs.paddingRight)  || 0;
  const availH = node.clientHeight - padT - padB;
  const availW = node.clientWidth  - padL - padR;

  const M = { t: 40, r: 60, b: 38, l: 18 };
  const H = Math.max(120, availH - (M.t + M.b));

  const AXIS_STEP = 145;
  const GUTTER_R  = 2000;
  const innerW = Math.max(dimsUsed.length * AXIS_STEP, (availW - (M.l + M.r)) + GUTTER_R);

  const svg = wrap.append('svg')
                  .attr('width',  innerW + M.l + M.r)
                  .attr('height', H + M.t + M.b)
                  .style('display', 'block');
  const g = svg.append('g').attr('transform', `translate(${M.l},${M.t})`);

  const x = d3.scalePoint()
              .domain(dimsUsed)
              .range([0, innerW - GUTTER_R])
              .padding(0.5);

  const y = {};
  const numericSet = new Set(state.numericKeys);
  // When neutralization is active, use score_neutral on the PCP score axis
  const useNeutralScore = !!(window.NEUTRAL && window.NEUTRAL.active);

  function getPCPVal(row, dim) {
    if (dim === "score" && useNeutralScore) {
      const v = row.score_neutral;
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return row[dim];
  }

  dimsUsed.forEach(dim => {
    if (numericSet.has(dim)) {
      const vals = state.data
        .map(d => {
          const v = getPCPVal(d, dim);
          return v != null && v !== "" ? +v : NaN;
        })
        .filter(Number.isFinite);
      y[dim] = d3.scaleLinear().domain(d3.extent(vals)).nice().range([H, 0]);
    } else {
      const cats = Array.from(
        new Set(
          state.data
            .map(d => getPCPVal(d, dim))
            .filter(v => v != null && v !== "")
        )
      ).sort();
      y[dim] = d3.scalePoint().domain(cats).range([H, 0]).padding(0.5);
    }
  });

  const isCatDim = {};
  const catAmp   = {};
  dimsUsed.forEach(dim => {
    isCatDim[dim] = !numericSet.has(dim);
    if (isCatDim[dim]) {
      const rng  = y[dim].range();
      const span = Math.abs(rng[1] - rng[0]);
      const steps = Math.max(1, y[dim].domain().length - 1);
      const step = span / steps;
      catAmp[dim] = Math.min(6, step * 0.18);
    }
  });
  function jitterFor(dim, row, val){
    if (!isCatDim[dim]) return 0;
    const s = dim + '|' + String(val) + '|' + row._id;
    let h = 2166136261;
    for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    const r01 = (h >>> 0) / 4294967295;
    return (r01 * 2 - 1) * catAmp[dim];
  }

  const d3line = d3.line().curve(d3.curveLinear);
  const rowPath = d => {
    const pts = [];
    for (const dim of dimsUsed) {
      const v  = getPCPVal(d, dim);
      const yy = y[dim](v);
      if (!Number.isFinite(yy)) continue;
      pts.push([ x(dim), yy + jitterFor(dim, d, v) ]);
    }
    return d3line(pts);
  };

  const area = d3.area()
    .x(d => x(d.dim))
    .y0(d => d.yLo)
    .y1(d => d.yHi)
    .curve(d3.curveLinear);

  function safeAreaPath(band){
    if (!band) return null;
    const pts = band.filter(p =>
      p && Number.isFinite(p.yLo) && Number.isFinite(p.yHi) &&
      Number.isFinite(x(p.dim))
    );
    if (pts.length < 2) return null;
    return area(pts);
  }

  function computeBandForGroup(gid){
    const rows = dataUniverse.filter(r => rowMatchesGroup(r, gid));
    if (!rows.length) return null;
    const clamp = v => Math.max(0, Math.min(H, v));
    const band = dimsUsed.map(dim => {
      const vals = rows.map(r => getPCPVal(r, dim)).filter(v => v != null && v !== '');
      if (numericSet.has(dim)) {
        const nums = vals.map(v => +v).filter(Number.isFinite);
        if (!nums.length) return { dim, yLo: NaN, yHi: NaN };
        const loV = quantile(nums, Q_LO);
        const hiV = quantile(nums, Q_HI);
        return { dim, yLo: clamp(y[dim](hiV)), yHi: clamp(y[dim](loV)) };
      } else {
        const cats = y[dim].domain();
        const used = new Set(vals);
        const ys   = cats.filter(c => used.has(c))
                         .map(c => y[dim](c))
                         .filter(Number.isFinite)
                         .sort((a,b)=>a-b);
        if (!ys.length) return { dim, yLo: NaN, yHi: NaN };
        const pad = 6;
        return { dim, yLo: clamp(ys[0] - pad), yHi: clamp(ys[ys.length-1] + pad) };
      }
    });
    return band;
  }

  function rowInAnyContextGroup(row){
    if (!window.contextGroupIds || !window.contextGroupIds.size) return false;
    for (const gid of window.contextGroupIds) if (rowMatchesGroup(row, gid)) return true;
    return false;
  }

  // ---------- Build rowId -> color map from stream selections ----------
  const ROW_COLOR = new Map();
  if (window.streamSelections && window.streamSelections.size) {
    for (const [key, sel] of window.streamSelections.entries()) {
      if (!sel || !sel.ids || !sel.color) continue;
      sel.ids.forEach(id => ROW_COLOR.set(id, sel.color));
    }
  }
  const rowId = d => (d?.id ?? d?._id ?? d?.row?.id ?? d?.row?._id);

  // --- rows to render in PCP (reused everywhere) ---
  const SELECTED_STREAM_IDS = new Set();
  if (window.streamSelections && window.streamSelections.size) {
    // Check if we have both outcome-based and feature-based selections
    const outcomeSelections = Array.from(window.streamSelections.values()).filter(sel => sel.outcome);
    const featureSelections = Array.from(window.streamSelections.values()).filter(sel => sel.feature);

    if (featureSelections.length > 0) {
      // If we have feature selections, ONLY show those IDs (they're already filtered from outcome selections)
      for (const sel of featureSelections) {
        if (sel && sel.ids && sel.ids.size) {
          sel.ids.forEach(id => SELECTED_STREAM_IDS.add(id));
        }
      }
    } else {
      // Otherwise, show all stream selections (outcome-based only)
      for (const sel of window.streamSelections.values()) {
        if (sel && sel.ids && sel.ids.size) {
          sel.ids.forEach(id => SELECTED_STREAM_IDS.add(id));
        }
      }
    }
  }
  function rowsForPCP(baseRows){
    // baseRows is your group-filtered pool (dataVisible)
    if (SELECTED_STREAM_IDS.size === 0) return baseRows;
    return baseRows.filter(r => SELECTED_STREAM_IDS.has(r.id ?? r._id));
  }

  // Layers
  const layerContext = g.append('g').attr('class','pcp-context');
  const layerOutcome = g.append('g').attr('class','pcp-outcomes');
  const layerStreams = g.append('g').attr('class','pcp-streams');
  const layerBG      = g.append('g').attr('class','pcp-bg');
  const layerFG      = g.append('g').attr('class','pcp-fg');
  const layerAxes    = g.append('g').attr('class','pcp-axes');

  // Draw background/main ONLY when no context is active
  if (!hasContext){
    // NEW: Adjust opacity based on summarize mode
    const bgOpacity = window.pcpSummarizeMode ? 0.03 : 0.10;
    const fgOpacity = window.pcpSummarizeMode ? 0.15 : 0.55;

    layerBG.selectAll('path').data(rowsForPCP(dataVisible))
      .join('path')
        .attr('d', rowPath)
        .attr('fill','none')
        .attr('stroke','#bbb')
        .attr('stroke-opacity', bgOpacity);

    const defaultStroke = d => {
      const gname = groupOf(d);
      // 1) If groups are explicitly selected, honor that.
      if (selectedGroups && selectedGroups.size > 0) {
        return gname ? colorForGroup(gname) : "#bbb";
      }
      // 2) If outcomes are selected, color by outcome.
      if (selOut && selOut.size > 0) {
        const o = ro(d);
        return OUTCOME_COLORS[o] || "#bbb";
      }
      // 3) DEFAULT (initial load / no selections): color by GROUP.
      return gname ? colorForGroup(gname) : "#bbb";
    };

    layerFG.selectAll('path').data(rowsForPCP(dataVisible))
      .join('path')
        .attr('d', rowPath)
        .attr('fill','none')
        // If summarize mode is on, make all lines gray; otherwise use color
        .attr('stroke', d => window.pcpSummarizeMode ? '#bbb' : (ROW_COLOR.get(rowId(d)) || defaultStroke(d)))
        .attr('stroke-opacity', fgOpacity)
        .attr('stroke-width',1);
  }

  // Context bands (always grey)
  if (hasContext){
    const ctxData = Array.from(contextGroupIds).map(gid => {
      const band = computeBandForGroup(gid);
      return band ? { gid, band } : null;
    }).filter(Boolean);

    layerContext.selectAll('path.pcp-context-band')
      .data(ctxData, d => d.gid)
      .join(
        enter => enter.append('path')
          .attr('class','pcp-context-band')
          .attr('fill', CONTEXT_FILL_COLOR)
          .attr('fill-opacity', CONTEXT_FILL_OPACITY)
          .attr('stroke', CONTEXT_STROKE_COLOR)
          .attr('stroke-opacity', CONTEXT_STROKE_OPACITY)
          .attr('stroke-width', 2)
          .style('pointer-events','none')
          .attr('d', d => safeAreaPath(d.band))
          .attr('display', d => safeAreaPath(d.band) ? null : 'none'),
        update => update
          .attr('fill', CONTEXT_FILL_COLOR)
          .attr('stroke', CONTEXT_STROKE_COLOR)
          .attr('d', d => safeAreaPath(d.band))
          .attr('display', d => safeAreaPath(d.band) ? null : 'none'),
        exit => exit.remove()
      );
  }

  // Outcome lines ON TOP OF the band — ONLY when outcomes are selected
  function outcomeColorFromRow(d){
    // First check if this row is part of a stream selection (from confusion bar click)
    const rowId = d.id ?? d._id;
    if (ROW_COLOR.has(rowId)) {
      return ROW_COLOR.get(rowId);
    }

    // Otherwise use the default outcome color
    const o = ro(d);
    return OUTCOME_COLORS[o] || '#000';
  }

  let outcomeRows = [];
  if (hasContext && selOut.size > 0) {
    outcomeRows = rowsForPCP(state.data).filter(r => rowInAnyContextGroup(r) && selOut.has(ro(r)));
  }

  const keyRow = d => d.id ?? d._id;

  // halo for contrast
  layerOutcome.selectAll('path.pcp-outcome-halo')
    .data(outcomeRows, keyRow)
    .join('path')
      .attr('class', 'pcp-outcome-halo')
      .attr('d', rowPath)
      .attr('fill', 'none')
      .attr('stroke', '#fff')
      .attr('stroke-width', 2.2)
      .attr('stroke-opacity', 0.9)
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round');

  layerOutcome.selectAll('path.pcp-outcome')
    .data(outcomeRows, keyRow)
    .join('path')
      .attr('class', 'pcp-outcome')
      .attr('d', rowPath)
      .attr('fill', 'none')
      .attr('stroke', d => outcomeColorFromRow(d))
      .attr('stroke-width', 1.4)
      .attr('stroke-opacity', 0.95)
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round');

  // ---------- selected stream overlays (always shown if any) ----------
  // window.streamSelections is a Map<string, {group, outcome, ids:Set, color?:string}>
  // If we have feature selections, ONLY show those (not the underlying outcome selections)
  const allSelections = Array.from(window.streamSelections?.values?.() || []);
  const hasFeatureSelectionsForOverlay = allSelections.some(sel => sel.feature);
  const selections = hasFeatureSelectionsForOverlay
    ? allSelections.filter(sel => sel.feature)
    : allSelections;

  const streamRowsColored = [];
  if (selections.length){
    for (const sel of selections) {
      const color = sel.color || OUTCOME_COLORS[sel.outcome] || '#000';
      for (const r of state.data) {
        const rid = r.id ?? r._id;
        if (rid != null && sel.ids.has(rid)) {
          const key = sel.feature
            ? `${sel.displayName || sel.group}|${sel.feature}:${sel.bucket}`
            : `${sel.group}|${sel.outcome}`;
          streamRowsColored.push({ row: r, color, key });
        }
      }
    }
  }

  const streamDatumKey = d => (d.row.id ?? d.row._id) + "|" + d.key;

  layerStreams.selectAll('path.pcp-stream')
    .data(streamRowsColored, streamDatumKey)
    .join('path')
      .attr('class','pcp-stream')
      .attr('d', d => rowPath(d.row))
      .attr('fill','none')
      // Prefer the color from the row→color map to ensure absolute consistency
      .attr('stroke', d => ROW_COLOR.get(rowId(d)) || d.color)
      .attr('stroke-width', 1)
      .attr('opacity', 0.75)
      .attr('pointer-events', 'none');

  // Axes + brushing
  clearSliceMetrics();

  const axes = layerAxes.selectAll('.dimension')
    .data(dimsUsed)
    .join('g')
      .attr('class','dimension')
      .attr('transform', d => `translate(${x(d)},0)`);

  axes.each(function(dim){
    const sel = d3.select(this);
    const axis = numericSet.has(dim) ? d3.axisLeft(y[dim]).ticks(4) : d3.axisLeft(y[dim]);
    sel.call(axis);

    const idx = dimsUsed.indexOf(dim);
    const tiltDeg = -25;
    const yTitle = -10;
    const yOffset = (idx % 2 ? 0 : 0);

    // Use cached baseline scores when in single-group mode, else current scores
    const SCORE_TABLE = (USE_INITIAL_AXES && window._pcpInitial?.scores) ? window._pcpInitial.scores : window._pcpSU;

    // Find this dim's score in the chosen table
    const scoreInfo = SCORE_TABLE && SCORE_TABLE.find(s => s.d === dim);
    const pval = scoreInfo ? scoreInfo.p : null;
    const isSignificant = (pval !== null && pval !== undefined && pval < ALPHA_SU);

    const titleText = dim + (isSignificant ? '*' : '');
    const titleColor = isSignificant ? '#d62728' : '#000';

    sel.append('text')
        .attr('class', 'axis-title')
        .attr('x', 0)
        .attr('y', yTitle + yOffset)
        .attr('text-anchor', 'start')
        .attr('fill', titleColor)
        .attr('data-original-color', titleColor)
        .attr('data-is-significant', isSignificant)
        .style('font-size', '10px')
        .style('font-weight', isSignificant ? 'bold' : 'normal')
        .attr('transform', `rotate(${tiltDeg}, 0, ${yTitle + yOffset})`)
        .text(titleText)
        .on('mouseenter', function() {
          const isSelected = d3.select(this).classed("neutralize-selected");
          if (!isSelected) {
            d3.select(this)
              .style('font-size', '12px')
              .style('font-weight', 'bold')
              .style('fill', '#0078d4');
          }
        })
        .on('mouseleave', function() {
          const isSelected = d3.select(this).classed("neutralize-selected");
          if (!isSelected) {
            const originalColor = d3.select(this).attr('data-original-color');
            const isSig = d3.select(this).attr('data-is-significant') === 'true';
            d3.select(this)
              .style('font-size', '10px')
              .style('font-weight', isSig ? 'bold' : 'normal')
              .style('fill', originalColor);
          }
        });

    // NEW: Add mini distribution bar charts when summarize mode is on
    if (window.pcpSummarizeMode) {
      renderAxisDistribution(sel, dim, y[dim], numericSet.has(dim), H);
    }

    window.pcpBrush = window.pcpBrush || {};

    function passAll(row){
      for (const [k, rule] of Object.entries(window.pcpBrush)){
        if (rule.type === 'num'){
          const v = +row[k];
          if (!Number.isFinite(v) || v < rule.lo || v > rule.hi) return false;
        } else if (rule.type === 'cat'){
          const val = (row[k] ?? 'NA');
          if (!rule.keep.has(val)) return false;
        }
      }
      return true;
    }

    // Helpers so brush works for both raw rows and {row,...} wrappers (streams)
    const rowOrSelf = d => (d && d.row) ? d.row : d;
    const visRow = d => passAll(rowOrSelf(d)) ? null : 'none';

    sel.append('g')
      .attr('class','brush')
      .call(d3.brushY()
        .extent([[-8, 0], [8, H]])
        .on('brush end', ({selection}) => {
          if (!selection){
            delete window.pcpBrush[dim];
          } else if (y[dim].invert){
            const [y0, y1] = selection.map(y[dim].invert);
            const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
            window.pcpBrush[dim] = { type: 'num', lo, hi };
          } else {
            const lo = selection[0], hi = selection[1];
            const keep = new Set(
              y[dim].domain().filter(v => {
                const py = y[dim](v);
                return py >= lo && py <= hi;
              })
            );
            window.pcpBrush[dim] = { type: 'cat', keep };
          }

          if (!hasContext){
            layerFG.selectAll('path').attr('display', visRow);
            layerBG.selectAll('path').attr('display', visRow);
          }
          layerOutcome.selectAll('path.pcp-outcome').attr('display', visRow);
          layerOutcome.selectAll('path.pcp-outcome-halo').attr('display', visRow);
          layerStreams.selectAll('path.pcp-stream').attr('display', d => passAll(d.row) ? null : 'none');

          const sub = rowsForPCP(dataVisible);
          const rowsSel = sub.filter(passAll);

          if (Object.keys(window.pcpBrush).length > 0) {
            // User has an active brush: show filtered metrics and confusion bars for the subset
            renderSliceMetrics(rowsSel);
            updateConfusionBarsWithFilter(rowsSel);
          } else {
            // User cleared the brush: show baseline
             renderSliceMetrics();
             updateConfusionBarsWithFilter(null);
          }
          renderGroupBars(rowsSel);


          if (Object.keys(window.pcpBrush).length === 0) renderSliceMetrics();
        })
      );
  });

    makeAxisTitlesClickableWithDistribution();

    // Initialize or update distribution
    if (!window.currentDistributionFeature) {
      window.currentDistributionFeature = "score";
      renderFeatureDistribution("score");
    } else {
      updateFeatureDistribution();
    }

    // Neutralization styling
    if (window.neutralizationFeatures && window.neutralizationFeatures.size > 0) {
      d3.selectAll(".axis-title").each(function(d) {
        if (window.neutralizationFeatures.has(d)) {
          const sel = d3.select(this);
          // Only save original color if not already saved (preserve the initial value)
          if (!sel.attr('data-original-color')) {
            sel.attr('data-original-color', sel.style('fill') || sel.attr('fill') || '#000');
          }
          sel.classed("neutralize-selected", true)
            .style('font-size', '12px')
            .style('font-weight', 'bold')
            .style('fill', '#d62728');
        }
      });
    }

}

function resetPcpFilters() {
  // Clear all stored brush rules
  window.pcpBrush = {};

  // Re-render PCP in the default (unbrushed) state
  renderPCP();

  // If you want everything else that depends on the current slice
  // to refresh as well, keep these; otherwise you can omit them.
  updateFeatureDistribution();
  renderSliceMetrics();
  renderGroupBars();
  updateConfusionBarsWithFilter(null);
}





// ===== Legend for significance markers =====
function renderPCPSignificanceLegend(){
  const host = d3.select("#pcp-sig-legend");
  if (host.empty()) return;

  host.selectAll("*").remove();

  host.append("div")
    .attr("class", "legend-title")
    .text("Axis Significance");

  const items = host.append("div")
    .style("display", "flex")
    .style("flex-direction", "column")
    .style("gap", "6px")
    .style("padding", "4px 0");

  items.append("div")
    .style("font-size", "11px")
    .html(`<span style="color:#d62728;font-weight:bold;">*</span> p &lt; ${ALPHA_SU} (significant)`);

  items.append("div")
    .style("font-size", "11px")
    .html(`Permutation test: ${N_PERM_PVALUE} shuffles`);

  items.append("div")
    .style("font-size", "10px")
    .style("color", "#666")
    .html("Hover axis title for SU &amp; p-value");
}

// Call this after updateAll() to refresh the legend
function refreshPCPLegends(){
  renderPCPSignificanceLegend();
}





// ---- PCP slice metrics panel (right column) ----
function ensureSlicePanel(){
  const host = d3.select("#summary-panel .content");
  if (!host.empty() && host.select("#pcp-slice-summary").empty()){
    host.append("hr");
    host.append("div").attr("id","pcp-slice-summary");
  }
}

function fmt3(x){ return (isNaN(x) ? "—" : d3.format(".3f")(x)); }

function computeSliceMetrics(rows){
  const n = rows.length;
  let tp=0, fp=0, tn=0, fn=0;
  rows.forEach(r=>{
    const t=+r.true_label, p=+r.prediction;
    if (t===1 && p===1) tp++;
    else if (t===0 && p===1) fp++;
    else if (t===0 && p===0) tn++;
    else if (t===1 && p===0) fn++;
  });
  const total = tp+fp+tn+fn;
  const safe = (num,den) => (den>0 ? num/den : NaN);
  const tpr = safe(tp, tp+fn);               // Equal Opportunity
  const fpr = safe(fp, fp+tn);               // Predictive Equality
  const ppv = safe(tp, tp+fp);               // Predictive Parity
  const ppr = safe(tp+fp, total);            // Demographic Parity
  const te  = safe(fn, fp);                  // Treatment Equality
  const eo  = (isNaN(tpr)||isNaN(fpr)) ? NaN : Math.abs(tpr - fpr); // Equalized Odds |TPR−FPR|
  return { n: total, tp, fp, tn, fn, tpr, fpr, ppv, ppr, te, eo };
}




function renderSliceMetrics(rows) {
  const wrap = d3.select("#pcp-slice-summary");
  
  // If the container doesn't exist, create it
  if (wrap.empty()) {
    d3.select("#summary-panel .content").append("div").attr("id","pcp-slice-summary");
  }
  
  wrap.selectAll("*").remove();

  // Determine data to use:
  // 1. If rows explicitly passed and has data, use them
  // 2. Otherwise use ALL state.data (baseline)
  const dataToUse = (rows && rows.length) ? rows : (state?.data || []);

  const groups = (window.LAST_GROUP_NAMES || []).slice();
  if (!groups.length || !dataToUse.length) {
    wrap.append("div").attr("class","muted")
      .text("No groups available. Select protected attributes first.");
    return;
  }

  // --- Compute per-group confusion matrices ---
  const perGroupData = groups.map(g => {
    const groupRows = dataToUse.filter(r => rowMatchesGroup(r, g));
    let tp=0, fp=0, tn=0, fn=0;
    groupRows.forEach(r => {
      const gt  = +r.true_label;
      const pr  = +r.prediction;
      if (gt===1 && pr===1) tp++;
      else if (gt===0 && pr===1) fp++;
      else if (gt===0 && pr===0) tn++;
      else if (gt===1 && pr===0) fn++;
    });
    return {
      group: g,
      tp, fp, tn, fn,
      total: tp + fp + tn + fn
    };
  }).filter(d => d.total > 0);

  if (!perGroupData.length) {
    wrap.append("div").attr("class","muted")
      .text("No rows match selected groups.");
    return;
  }

  // --- Render stacked bar chart with PERCENTAGES ---
  const M = { t: 30, r: 12, b: 80, l: 50 };
  const W = Math.max(300, wrap.node()?.clientWidth || 400);
  const H = 240;
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;

  const svg = wrap.append("svg")
    .attr("width", W)
    .attr("height", H)
    .style("display", "block");

  const g = svg.append("g").attr("transform", `translate(${M.l},${M.t})`);

  // X scale: groups
  const x = d3.scaleBand()
    .domain(perGroupData.map(d => d.group))
    .range([0, innerW])
    .padding(0.5);

  // Y scale: 0-100%
  const y = d3.scaleLinear()
    .domain([0, 100])
    .range([innerH, 0]);

  // Color scale for confusion outcomes
  const outcomeColors = {
    TP: "#2ca02c",
    FP: "#d62728",
    TN: "#1f77b4",
    FN: "#9467bd"
  };

  // Convert to percentage and prepare stacked data
  const stackData = perGroupData.map(d => {
    const total = d.tp + d.fp + d.tn + d.fn;
    return {
      group: d.group,
      TP: (d.tp / total) * 100,
      FP: (d.fp / total) * 100,
      TN: (d.tn / total) * 100,
      FN: (d.fn / total) * 100,
      counts: { tp: d.tp, fp: d.fp, tn: d.tn, fn: d.fn, total }
    };
  });

  const stack = d3.stack()
    .keys(["TP", "FP", "TN", "FN"])
    .order(d3.stackOrderNone);

  const stackedData = stack(stackData);

  // --- Draw stacked bars ---
  const layers = g.selectAll("g.layer")
    .data(stackedData)
    .join("g")
      .attr("class", "layer")
      .attr("fill", d => outcomeColors[d.key]);

  layers.selectAll("rect")
    .data(d => d.map((v, i) => ({ ...v, outcome: d.key, dataIdx: i })))
    .join("rect")
      .attr("x", d => x(stackData[d.dataIdx].group))
      .attr("y", d => y(d[1]))
      .attr("width", x.bandwidth())
      .attr("height", d => y(d[0]) - y(d[1]))
      .attr("stroke", "#fff")
      .attr("stroke-width", 0.5)
      .append("title")
        .text(d => {
          const data = stackData[d.dataIdx];
          const pct = d[1] - d[0];
          const count = data.counts[d.outcome.toLowerCase()];
          return `${data.group}\n${d.outcome}: ${count} (${pct.toFixed(1)}%)`;
        });

  // --- Axes ---
  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x))
    .selectAll("text")
      .style("text-anchor", "end")
      .attr("dx", "-0.4em")
      .attr("dy", "0.35em")
      .attr("transform", "rotate(-25)")
      .style("font-size", "11px");

  g.append("g")
    .call(d3.axisLeft(y).ticks(5))
    .selectAll("text")
      .style("font-size", "10px");

  g.append("text")
    .attr("x", -innerH / 2)
    .attr("y", -40)
    .attr("text-anchor", "middle")
    .attr("transform", "rotate(-90)")
    .style("font-size", "11px")
    .style("font-weight", "600")
    .text("Percentage (%)");

  // --- Legend with 2x2 grid ---
  const outcomes = ["TP", "FP", "TN", "FN"];
  const outcomeLabels = {
    TP: "True Positive",
    FP: "False Positive",
    TN: "True Negative",
    FN: "False Negative"
  };

  const LEG_COLS = 2;
  const LEG_SPACING_X = 90;
  const LEG_SPACING_Y = 14;
  const legendWidth = (LEG_COLS - 1) * LEG_SPACING_X + 80;
  const legX = innerW - legendWidth - 100;
  const legY = innerH + 30;

  const leg = g.append("g")
    .attr("transform", `translate(${legX},${legY})`);

  const legItems = leg.selectAll("g.leg-item")
    .data(outcomes)
    .join("g")
      .attr("class", "leg-item")
      .attr("transform", (d, i) => {
        const col = i % LEG_COLS;
        const row = Math.floor(i / LEG_COLS);
        return `translate(${col * LEG_SPACING_X}, ${row * LEG_SPACING_Y})`;
      });

  legItems.append("rect")
    .attr("width", 10)
    .attr("height", 10)
    .attr("fill", d => outcomeColors[d])
    .attr("stroke", "#333")
    .attr("stroke-width", 0.5);

  legItems.append("text")
    .attr("x", 14)
    .attr("y", 9)
    .style("font-size", "10px")
    .text(d => outcomeLabels[d]);

  // --- Summary stats footer ---
  const totalRows = d3.sum(perGroupData, d => d.total);
  const totalTP = d3.sum(perGroupData, d => d.tp);
  const totalFP = d3.sum(perGroupData, d => d.fp);
  const totalTN = d3.sum(perGroupData, d => d.tn);
  const totalFN = d3.sum(perGroupData, d => d.fn);

  svg.append("text")
    .attr("x", M.l)
    .attr("y", H - 8)
    .style("font-size", "10px")
    .style("fill", "#666")
    .text(`Total: ${totalRows} • TP: ${totalTP} FP: ${totalFP} TN: ${totalTN} FN: ${totalFN}`);
}


function clearSliceMetrics(){
  const box = d3.select("#pcp-slice-summary");
  if (!box.empty()){
    box.selectAll("*").remove();
    box.append("div").attr("class","muted")
      .text("Brush axes in the PCP to compute slice-only metrics.");
  }
}

// --- build groups given current selection ---
function currentGroups(){
  // returns [{name, rows:[row,...]} ...]
  if (selectedGroups.size > 0){
    const names = Array.from(selectedGroups);
    return names.map(name => ({
      name,
      rows: state.data.filter(r => rowMatchesGroup(r, name))
    })).filter(g => g.rows.length > 0);
  }
  // else: group by currentProtected combo
  const keys = resolvePcpKeys(); // you already have this
  const map = new Map();
  state.data.forEach(r => {
    const name = keys.map(k => `${k}=${r[k]}`).join(" ∧ ");
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(r);
  });
  return Array.from(map, ([name, rows]) => ({ name, rows })).filter(g => g.rows.length > 0);
}

// --- Kruskal–Wallis effect size ε² for numeric X ---
function kwEpsilon2Numeric(feature, groups){
  // collect values per group
  const vals = [];
  groups.forEach((g, gi) => {
    g.rows.forEach(r => {
      const x = +r[feature];
      if (Number.isFinite(x)) vals.push({x, gi});
    });
  });
  const N = vals.length, k = groups.length;
  if (N < 2 || k < 2) return 0;

  // rank all values (average ranks for ties)
  vals.sort((a,b)=>a.x-b.x);
  let i = 0, rank = 1;
  while (i < N){
    let j = i+1;
    while (j < N && vals[j].x === vals[i].x) j++;
    const avg = (rank + (rank + (j-i) - 1)) / 2;
    for (let t=i; t<j; t++) vals[t].rank = avg;
    rank += (j - i);
    i = j;
  }

  // sum of ranks by group
  const Rbar = Array(k).fill(0);
  const n = Array(k).fill(0);
  vals.forEach(v => { Rbar[v.gi] += v.rank; n[v.gi]++; });
  const mu = (N + 1) / 2;               // mean rank

  // Kruskal–Wallis H
  let sum = 0;
  for (let g=0; g<k; g++){
    if (n[g] > 0){
      const Rg = Rbar[g] / n[g];
      sum += n[g] * (Rg - mu) * (Rg - mu);
    }
  }
  const H = (12 / (N * (N + 1))) * sum;
  // Effect size ε² in [0,1]
  const eps2 = Math.max(0, Math.min(1, (H - k + 1) / (N - k)));
  return isFinite(eps2) ? eps2 : 0;
}

// --- Cramér’s V between categorical feature and group label ---
function cramersVFeatureVsGroup(feature, groups){
  // index categories
  const catIndex = new Map(); let c = 0;
  const gIndex = new Map(groups.map((g,i)=>[g.name,i])); const r = groups.length;

  // build contingency
  const counts = []; // r x c
  let N = 0;
  groups.forEach((g, gi) => {
    g.rows.forEach(row => {
      const a = row[feature];
      if (a == null) return;
      if (!catIndex.has(a)) { catIndex.set(a, c++); for (let i=0;i<r;i++) (counts[i]||(counts[i]=[]))[c-1]=0; }
      const cj = catIndex.get(a);
      counts[gi][cj] = (counts[gi][cj]||0) + 1;
      N++;
    });
  });
  if (N === 0 || r < 2 || c < 2) return 0;

  const rowSum = counts.map(row => row.reduce((s,v)=>s+(v||0),0));
  const colSum = Array(c).fill(0);
  for (let j=0;j<c;j++) for (let i=0;i<r;i++) colSum[j]+=counts[i][j]||0;

  let chi2 = 0;
  for (let i=0;i<r;i++){
    for (let j=0;j<c;j++){
      const O = counts[i][j]||0;
      const E = (rowSum[i]*colSum[j])/N || 1e-12;
      const d = O - E;
      chi2 += (d*d)/E;
    }
  }
  const kmin = Math.min(r-1, c-1);
  if (kmin <= 0) return 0;
  const V = Math.sqrt(chi2 / (N * kmin));
  return Math.min(1, V);
}

// ===== Symmetrical Uncertainty (SU) =====

function _quantileBins(arr, k = 5) {
  // keep only finite numbers and sort
  const vals = arr
    .map(Number)
    .filter(x => Number.isFinite(x))
    .sort((a, b) => a - b);

  if (vals.length === 0) {
    return { edges: [], toBin: _ => null, k: 0 };
  }
  if (k <= 1) {
    const lo = vals[0], hi = vals[vals.length - 1];
    return { edges: [lo, hi], toBin: _ => 0, k: 1 };
  }

  // compute (approximately) k quantile breakpoints
  const edges = [vals[0]];
  for (let i = 1; i < k; i++) {
    const q = i / k;
    const idx = Math.floor(q * (vals.length - 1));
    edges.push(vals[idx]);
  }
  edges.push(vals[vals.length - 1]);

  // de-duplicate edges if data are tied
  const uniq = [];
  for (const e of edges) {
    if (uniq.length === 0 || e > uniq[uniq.length - 1]) uniq.push(e);
  }
  const kEff = Math.max(1, uniq.length - 1);

  // map a value to its bin index
  const toBin = (val) => {
    const x = +val;
    if (!Number.isFinite(x)) return null;
    // find first edge that is >= x (right-closed bins)
    let j = 0;
    while (j < kEff && x > uniq[j + 1]) j++;
    return Math.min(j, kEff - 1);
  };

  return { edges: uniq, toBin, k: kEff };
}



// Build contingency table counts for (feature → categories) × (label → classes)
function _contingency(featureVals, labelVals){
  const A = new Map(), B = new Map();
  let ai=0, bi=0;
  for (let i=0;i<featureVals.length;i++){
    const a = featureVals[i], b = labelVals[i];
    if (a==null || b==null) continue;
    if (!A.has(a)) A.set(a, ai++);
    if (!B.has(b)) B.set(b, bi++);
  }
  const r=A.size, c=B.size;
  if (r<2 || c<2) return {table:[], rowSum:[], colSum:[], N:0}; // degenerate
  const table = Array.from({length:r}, ()=>Array(c).fill(0));
  let N=0;
  for (let i=0;i<featureVals.length;i++){
    const a = featureVals[i], b = labelVals[i];
    if (!A.has(a) || !B.has(b)) continue;
    table[A.get(a)][B.get(b)]++;
    N++;
  }
  const rowSum = table.map(row => row.reduce((s,v)=>s+v,0));
  const colSum = Array(c).fill(0);
  for (let j=0;j<c;j++) for (let i=0;i<r;i++) colSum[j]+=table[i][j];
  return {table, rowSum, colSum, N};
}

function _entropyFromCounts(counts, N){
  if (N<=0) return 0;
  let H=0;
  for (const n of counts){
    if (n>0){ const p=n/N; H -= p * Math.log2(p); }
  }
  return H;
}
function _miFromContingency({table,rowSum,colSum,N}){
  if (N<=0) return 0;
  let I=0;
  for (let i=0;i<table.length;i++){
    for (let j=0;j<table[0].length;j++){
      const n = table[i][j];
      if (n===0) continue;
      const pxy = n/N;
      const px  = rowSum[i]/N;
      const py  = colSum[j]/N;
      I += pxy * Math.log2(pxy/(px*py));
    }
  }
  return I;
}
function _suFromContingency(C){
  const Hx = _entropyFromCounts(C.rowSum, C.N);
  const Hy = _entropyFromCounts(C.colSum, C.N);
  const I  = _miFromContingency(C);
  const denom = (Hx + Hy);
  return denom>0 ? (2*I)/denom : 0;
}

// SU separation score for one feature against a current label function
// - Numeric features are quantile-binned into k bins.
// - Categorical features are used as-is.
function suSeparationScore(feature, rows, labelFn, numericSet, kBins=6){
  const isNum = numericSet.has(feature);
  let feats=[], labels=[];
  if (isNum){
    const vals = rows.map(r => +r[feature]);
    const {toBin} = _quantileBins(vals, kBins);
    for (const r of rows){
      const lab = labelFn(r);
      if (lab==null) continue;
      const fbin = toBin(r[feature]);
      if (fbin==null) continue;
      feats.push(fbin); labels.push(lab);
    }
  } else {
    for (const r of rows){
      const lab = labelFn(r);
      if (lab==null) continue;
      const v = r[feature];
      if (v==null) continue;
      feats.push(String(v)); labels.push(String(lab));
    }
  }
  const C = _contingency(feats, labels);
  if (C.N < 3 || C.table.length===0) return 0; // not enough support
  return _suFromContingency(C);
}


// --------- Which rows & labels are we comparing? ---------
function _currentLabelFn(){
  // Priority 1: user-selected outcomes (TP/FP/TN/FN)
  if (selectedOutcomes && selectedOutcomes.size){
    const keep = new Set([...selectedOutcomes]);
    return r => {
      const o = rowOutcome(r);
      return keep.has(o) ? o : null;
    };
  }

  // Priority 2: user-selected group nodes
  if (selectedGroups && selectedGroups.size){
    return r => firstMatchingGroup(r); // null if none
  }
  // Fallback: all four outcomes as classes
  return r => rowOutcome(r);
}

// Only SU separation score for now
function separationScore(feature, rows){
  const numericSet = new Set(state.numericKeys);
  const labelFn = _currentLabelFn();
  return suSeparationScore(feature, rows, labelFn, numericSet, 6);
}



// Updated pickAxes to compute p-values
// Surface Top-K PCP axes using 3×SU + KS, with a fallback to p-value gating if you like
// Surface Top-K PCP axes using 3×SU + KS, with a fallback to p-value gating if you like
function passGate(f) {
  if (EXCLUDE_ALWAYS.has(f.feature)) return false;

  // which q-family is relevant?
  let qRelevant = null;
  if (selectedGroups && selectedGroups.size > 0)      qRelevant = f.q_group   ?? f.q_score;
  else if (selectedOutcomes && selectedOutcomes.size) qRelevant = f.q_outcome ?? f.q_score;
  else                                                qRelevant = f.q_score   ?? f.q_label;

  const significant = (qRelevant != null && qRelevant <= ALPHA_Q);

  // SU effect-size gate by context
  const suStrong = (selectedGroups && selectedGroups.size > 0)
    ? (f.su_group ?? 0)   >= SU_MIN
    : ((f.su_score ?? 0)  >= SU_MIN || (f.su_outcome ?? 0) >= SU_MIN);

  const ksStrong = (f.ks_score ?? 0) >= KS_MIN;

  return significant && suStrong && ksStrong;
}
function rankFeature(a, b) {
  const MANY_GROUPS   = (selectedGroups && selectedGroups.size > 1);
  const MANY_OUTCOMES = (selectedOutcomes && selectedOutcomes.size > 1);

  let A, B;
  if (MANY_GROUPS) {
    A = 0.80*(a.su_group||0) + 0.30*(a.ks_score||0) + 0.20*(a.su_score||0);
    B = 0.80*(b.su_group||0) + 0.30*(b.ks_score||0) + 0.20*(b.su_score||0);
  } else if (MANY_OUTCOMES) {
    A = 0.80*(a.su_outcome||0) + 0.30*(a.ks_score||0) + 0.20*(a.su_score||0);
    B = 0.80*(b.su_outcome||0) + 0.30*(b.ks_score||0) + 0.20*(b.su_score||0);
  } else {
    A = 0.50*(a.su_score||0) + 0.30*(a.su_outcome||0) + 0.20*(a.su_label||0)
      + ((a.ks_score||0) >= KS_MIN ? 0.05 : 0);
    B = 0.50*(b.su_score||0) + 0.30*(b.su_outcome||0) + 0.20*(b.su_label||0)
      + ((b.ks_score||0) >= KS_MIN ? 0.05 : 0);
  }
  return B - A;
}

function _fmt(x, d=3){ return (x==null || !isFinite(x)) ? "—" : (+x).toFixed(d); }

function logSignificantFeatures(sigs){
  // keep only those that pass your gate
  const passed = sigs.filter(passGate).sort(rankFeature);

  console.group("✅ Significant features (passGate=true)");
  if (!passed.length) {
    console.warn("None passed the gate (q/p, SU_MIN, KS_MIN). Falling back to top-by-composite.");
  } else {
    // detailed list
    passed.forEach((s, i) => {
      const composite =
        0.50*(s.su_score||0) + 0.30*(s.su_outcome||0) + 0.20*(s.su_label||0) +
        ((s.ks_score||0) >= KS_MIN ? 0.05 : 0);
      console.log(
        `${i+1}. ${s.feature} | ` +
        `SU(score)=${_fmt(s.su_score)}  SU(outcome)=${_fmt(s.su_outcome)}  SU(label)=${_fmt(s.su_label)}  SU(group)=${_fmt(s.su_group)}  KS=${_fmt(s.ks_score)} | ` +
        `p_score=${_fmt(s.p_score,4)} q_score=${_fmt(s.q_score,4)}  p_out=${_fmt(s.p_outcome,4)} q_out=${_fmt(s.q_outcome,4)}  p_lbl=${_fmt(s.p_label,4)} q_lbl=${_fmt(s.q_label,4)} | ` +
        `composite=${_fmt(composite)}`
      );
    });

    // quick table view
    console.table(passed.map(s => ({
      feature: s.feature,
      su_score: +_fmt(s.su_score),
      su_outcome: +_fmt(s.su_outcome),
      su_label: +_fmt(s.su_label),
      su_group: +_fmt(s.su_group),
      ks_score: +_fmt(s.ks_score),
      p_score: s.p_score, q_score: s.q_score,
      p_outcome: s.p_outcome, q_outcome: s.q_outcome,
      p_label: s.p_label, q_label: s.q_label
    })));
  }
  console.groupEnd();
}


function pickAxes(dims, rows){
  if (!SHOW_TOP_ONLY) return dims;

  const sigs = computeFeatureSignals(dims, rows); // should include p/q/SU/KS
  window._featureSignals = sigs;

  logSignificantFeatures(sigs);

  // 1) significance-first gate
  let candidates = sigs.filter(passGate);

  // 2) if none pass, fall back to top few by composite (avoid empty UI)
  if (!candidates.length) candidates = sigs.slice(0, Math.min(6, sigs.length));

  // 3) rank and (optionally) cap
  candidates.sort(rankFeature);
  const finalList = (typeof TOP_K === 'number' && TOP_K > 0)
    ? candidates.slice(0, TOP_K).map(s => s.feature)
    : candidates.map(s => s.feature);

  // 4) whitelist/hide
  const HIDE = (typeof PCP_HIDE !== 'undefined') ? PCP_HIDE : new Set();
  const inWhitelist = d => !window.pcpFeatureWhitelist || window.pcpFeatureWhitelist.has(d);
  const filtered = finalList.filter(d => !HIDE.has(d) && inWhitelist(d));

  // 5) log
  console.log("=== Feature signals (Top 12) ===");
  sigs.slice(0,12).forEach((s,i)=> {
    console.log(`${i+1}. ${s.feature} | SU(score)=${s.su_score.toFixed(3)} SU(outcome)=${s.su_outcome.toFixed(3)} SU(label)=${s.su_label.toFixed(3)} KS(score)=${s.ks_score.toFixed(3)}`);
  });

  return filtered;
}


// --- SU from two arrays X, Y (values already discretized for numeric X) ---
function _suFromXY(X, Y){
  const M = _contingency(X, Y);   // you already have this
  return _suFromContingency(M);   // you already have this (2*I/(Hx+Hy))
}

// Fisher–Yates shuffle *in place*
function _shuffleInPlace(arr){
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// Permutation p-value for SU: how often permuted SU >= observed SU
function _permutePValueSU(X, Y, obsSU, nPerm = 200){
  const Yorig = Y.slice();
  let ge = 0;
  const permSUs = [];  // collect all permuted SU values for inspection
  
  for (let b = 0; b < nPerm; b++){
    const Yperm = Yorig.slice();
    _shuffleInPlace(Yperm);
    const suB = _suFromXY(X, Yperm);
    permSUs.push(suB);
    if (suB >= obsSU) ge++;
  }
    // LOG THIS:
  if (obsSU > 0.1) {  // only log for high-SU features like 'score'
    console.log(`Feature high SU: obsSU=${obsSU.toFixed(4)}`);
    console.log(`  Permuted SUs (first 20):`, permSUs.slice(0, 20).map(x => x.toFixed(4)));
    console.log(`  Mean permuted SU: ${(permSUs.reduce((a,b)=>a+b)/permSUs.length).toFixed(4)}`);
    console.log(`  How many perm SU >= obs: ${ge} / ${nPerm}`);
  }
  
  const p = (ge + 1) / (nPerm + 1);
  
  // // Debug: log first few permutations and observed SU
  // console.log(`  Observed SU: ${obsSU.toFixed(4)}`);
  // console.log(`  Count of perm SU >= obs: ${ge} / ${nPerm}`);
  // console.log(`  p-value: ${p.toFixed(4)}`);
  // console.log(`  First 10 permuted SUs:`, permSUs.slice(0, 10).map(x => x.toFixed(4)));
  // console.log(`  Min permuted SU: ${Math.min(...permSUs).toFixed(4)}, Max: ${Math.max(...permSUs).toFixed(4)}`);
  
  return p;
}

// Build discretizer for a feature (reuse your quantile binning for numeric)
function _discretizerForFeature(feature, rows, k=6){
  const isNum = new Set(state.numericKeys).has(feature);
  if (isNum){
    const vals = rows.map(r => +r[feature]).filter(Number.isFinite);
    const bin = _quantileBins(vals, k).toBin; // you already have this
    return r => bin(+r[feature]);
  } else {
    return r => r[feature];
  }
}

// SU + permutation p-value for a single feature
function suWithPValue(feature, rows, nPerm = N_PERM_PVALUE){
  const R = rows;
  if (!R.length) return { su: 0, p: 1, n: 0 };

  const toX = _discretizerForFeature(feature, R);
  const X = R.map(toX);
  const labelFn = _currentLabelFn();
  const Y = R.map(labelFn);

  // Remove nulls
  const XY = [];
  for (let i = 0; i < X.length; i++){
    if (X[i] != null && Y[i] != null) XY.push([X[i], Y[i]]);
  }
  if (XY.length < 5) return { su: 0, p: 1, n: XY.length };

  const Xc = XY.map(t => t[0]);
  const Yc = XY.map(t => t[1]);
  const su = _suFromXY(Xc, Yc);
  const p = _permutePValueSU(Xc, Yc, su, nPerm);

  return { su, p, n: XY.length };
}

// --- Compute ECDF and KS distance (for numeric scores) ---
function _ecdf(arr) {
  const x = arr.slice().filter(Number.isFinite).sort((a,b)=>a-b);
  const n = x.length || 1;
  return {
    x,
    F: t => {
      let lo=0, hi=x.length;
      while (lo<hi){ const mid=(lo+hi)>>1; (x[mid] <= t) ? (lo=mid+1) : (hi=mid); }
      return lo / n;
    }
  };
}
function _ksDistance(a, b){
  const A = a.filter(Number.isFinite), B = b.filter(Number.isFinite);
  if (!A.length || !B.length) return 0;
  const eA = _ecdf(A), eB = _ecdf(B);
  // evaluate at all unique score positions
  const xs = Array.from(new Set([...eA.x, ...eB.x]));
  let D = 0;
  for (const t of xs){
    const d = Math.abs(eA.F(t) - eB.F(t));
    if (d > D) D = d;
  }
  return D; // 0..1
}

// --- SU(feature; targetVector) with automatic discretization for numeric feature/target ---
function _suFeatureVsTarget(rows, feature, targetGetter, featureBins = 6, targetBins = 6){
  if (!rows?.length) return { su: 0, p: 1, n: 0 };

  // Discretize feature
  const isNumFeat = new Set(state.numericKeys).has(feature);
  let featToBin;
  if (isNumFeat){
    const vals = rows.map(r => +r[feature]).filter(Number.isFinite);
    const {toBin} = _quantileBins(vals, featureBins);
    featToBin = r => toBin(+r[feature]);
  } else {
    featToBin = r => String(r[feature]);
  }

  // Discretize/label target (score: numeric; outcome/label: categorical)
  let targToCls;
  const rawTvals = rows.map(r => targetGetter(r));
  const finiteNums = rawTvals.map(v => +v).filter(Number.isFinite);

  // Decide target mode
  const looksNumeric = finiteNums.length >= Math.floor(0.8 * rows.length); // mostly numeric?
  // Count unique raw target values (use strings to be robust)
  const uniqTargetVals = new Set(rawTvals.map(v => String(v))).size;

  // If "numeric" but only a few distinct values (e.g., binary label), treat as categorical
  const forceCategorical = looksNumeric && uniqTargetVals <= 3;

  if (!looksNumeric || forceCategorical) {
    // categorical target (TP/FP/TN/FN OR 0/1 labels)
    targToCls = r => {
      const v = targetGetter(r);
      return (v == null) ? null : String(v);
    };
  } else {
    // genuinely numeric target (e.g., score) → quantile bins
    const tVals = rows.map(r => +targetGetter(r)).filter(Number.isFinite);
    const {toBin, k} = _quantileBins(tVals, /*targetBins=*/6);
    // If binning degenerates (k<2), fall back to categorical strings
    if (k < 2) {
      targToCls = r => {
        const v = targetGetter(r);
        return (v == null) ? null : String(v);
      };
    } else {
      targToCls = r => toBin(+targetGetter(r));
    }
  }

  // Build X/Y, drop nulls
  const X=[], Y=[];
  for (const r of rows){
    const x = featToBin(r);
    const y = targToCls(r);
    if (x!=null && y!=null){ X.push(x); Y.push(y); }
  }
  if (X.length < 5) return { su: 0, p: 1, n: X.length };

  const su = _suFromXY(X, Y);
  const p  = _permutePValueSU(X, Y, su, N_PERM_PVALUE);
  return { su, p, n: X.length };
}

// --- KS(effect size) of score by feature (max pairwise over feature levels) ---
function ksEffectOnScore(rows, feature, bins = 6){
  if (!rows?.length) return 0;
  const isNumFeat = new Set(state.numericKeys).has(feature);
  let levelOf;
  if (isNumFeat){
    const vals = rows.map(r => +r[feature]).filter(Number.isFinite);
    const {toBin} = _quantileBins(vals, bins);
    levelOf = r => toBin(+r[feature]);
  } else {
    levelOf = r => String(r[feature]);
  }

  // group scores by feature level
  const buckets = new Map();
  for (const r of rows){
    const lv = levelOf(r);
    if (lv==null) continue;
    const s = +r.score;
    if (!Number.isFinite(s)) continue;
    if (!buckets.has(lv)) buckets.set(lv, []);
    buckets.get(lv).push(s);
  }
  const levels = Array.from(buckets.keys());
  if (levels.length < 2) return 0;

  // max pairwise KS across levels
  let Dmax = 0;
  for (let i=0;i<levels.length;i++){
    for (let j=i+1;j<levels.length;j++){
      const Di = _ksDistance(buckets.get(levels[i]), buckets.get(levels[j]));
      if (Di > Dmax) Dmax = Di;
    }
  }
  return Dmax; // 0..1
}

function bhFDR(ps){               // Benjamini–Hochberg (monotone q’s)
  const m = ps.length;
  const idx = ps.map((p,i)=>[p,i]).sort((a,b)=>a[0]-b[0]);
  const q = Array(m).fill(null);
  let minq = 1;
  for (let k=m; k>=1; k--){
    const p = idx[k-1][0];
    minq = Math.min(minq, (p * m) / k);
    q[idx[k-1][1]] = Math.min(1, minq);
  }
  return q;
}

// --- Compute the 3×SU + KS bundle for every feature in dims ---
function computeFeatureSignals(dims, rows){
  const numericSet   = new Set(state.numericKeys);
  const LABEL_FN     = _currentLabelFn();
  const MANY_GROUPS  = (selectedGroups && selectedGroups.size > 1);
  const MANY_OUTCOMES= (selectedOutcomes && selectedOutcomes.size > 1);

  const signals = dims.map(d => {
    const s_score   = _suFeatureVsTarget(rows, d, r => +r.score);        // {su,p,n}
    const s_outcome = _suFeatureVsTarget(rows, d, r => rowOutcome(r));   // {su,p,n}
    const s_label   = _suFeatureVsTarget(rows, d, r => +r.true_label);   // {su,p,n} 
    const s_group = (selectedGroups && selectedGroups.size > 1)
      ? _suFeatureVsTarget(rows, d, r => LABEL_FN(r))   // returns {su,p,n}
      : { su: 0, p: 1, n: 0 };

    // const su_group  = MANY_GROUPS
    //   ? suSeparationScore(d, rows, LABEL_FN, numericSet, 6)
    //   : 0;

    const ks_score  = ksEffectOnScore(rows, d);

    return {
      feature   : d,
      su_score  : s_score.su,   p_score  : s_score.p,
      su_outcome: s_outcome.su, p_outcome: s_outcome.p,
      su_label  : s_label.su,   p_label  : s_label.p,
      su_group  : s_group.su,   p_group  : s_group.p,
      ks_score
    };
  });

  // === Add BH-FDR q-values per family (score/outcome/label) ===
  ["score","outcome","label","group"].forEach(fam => {
    const idxs = signals.map((s,i) => Number.isFinite(s[`p_${fam}`]) ? i : -1).filter(i => i >= 0);
    if (idxs.length >= 2){
      const ps = idxs.map(i => signals[i][`p_${fam}`]);
      const qs = bhFDR(ps);
      idxs.forEach((i,j) => { signals[i][`q_${fam}`] = qs[j]; });
    } else {
      // optional: fallback so q = p when there aren’t enough to run BH
      idxs.forEach(i => { signals[i][`q_${fam}`] = signals[i][`p_${fam}`]; });
    }
  });

  // === your existing context-aware ranking ===
  signals.sort((a,b) => {
    let A, B;
    if (MANY_GROUPS){
      A = 0.80*a.su_group + 0.30*a.ks_score + 0.20*a.su_score;
      B = 0.80*b.su_group + 0.30*b.ks_score + 0.20*b.su_score;
    } else if (MANY_OUTCOMES){
      A = 0.80*a.su_outcome + 0.30*a.ks_score + 0.20*a.su_score;
      B = 0.80*b.su_outcome + 0.30*b.ks_score + 0.20*b.su_score;
    } else {
      A = Math.max(a.su_outcome, a.su_score) + 0.50*a.ks_score + 0.25*a.su_label;
      B = Math.max(b.su_outcome, b.su_score) + 0.50*b.ks_score + 0.25*b.su_label;
    }
    return d3.descending(A, B);
  });

  window._featureSignals = signals;
  return signals;
}

// === overlay toggle (optional UI can toggle this) ===
window.SHOW_OVERLAY_AFTER = true;

// Resolve which scalar field to chart for the chosen metric
function metricFieldForBars(metric){
  // For Equalized Odds we usually show a component; reuse any existing selector if you have one.
  // Fallback: show TPR component.
  const eoComp = (window.EO_COMPONENT || "tpr"); // "tpr" or "fpr" if you expose a toggle
  switch (metric) {
    case "equal_opportunity":   return "tpr";
    case "predictive_parity":   return "ppv";
    case "predictive_equality": return "fpr";
    case "demographic_parity":  return "ppr";
    case "treatment_equality":  return "te";   // if you compute FN/FP per group
    case "equalized_odds":      return eoComp; // show TPR or FPR component
    default:                    return "tpr";
  }
}

// Compute per-group metrics for given rows at the current threshold
function _perGroupMetrics(rows, thr){
  const groups = (window.LAST_GROUP_NAMES || []).slice();
  return groups.map(g => {
    const slice = rows.filter(r => rowMatchesGroup(r, g));
    const m = confusionAndFairness(slice, thr);    // you already have this helper
    return { group: g, ...m };
  });
}

// === GAP DEFINITIONS (2 groups only: e.g., <30 vs ≥30) ======================
function computePerGroup(rows, groupKey, thr){
  const byG = d3.group(rows, r => r[groupKey]);
  const out = new Map();
  for (const [g, arr] of byG) out.set(g, confusionAndFairness(arr, thr));
  return out;
}

// Return { eo, ppv, fpr, ppr, tpr, te } gaps for two groups
function computeGaps(rows, groupKey, thr){
  const m = computePerGroup(rows, groupKey, thr);
  const [g1, g2] = Array.from(m.keys());
  if (g1 == null || g2 == null) return null;
  const a = m.get(g1), b = m.get(g2);

  // components (absolute diffs)
  const tpr_gap = Math.abs((a.tpr ?? 0) - (b.tpr ?? 0));
  const fpr_gap = Math.abs((a.fpr ?? 0) - (b.fpr ?? 0));
  const ppv_gap = Math.abs((a.ppv ?? 0) - (b.ppv ?? 0));
  const ppr_gap = Math.abs((a.ppr ?? 0) - (b.ppr ?? 0));
  // Equalized Odds as max component (use L2 if you prefer)
  const eo_gap  = Math.max(tpr_gap, fpr_gap);
  // Treatment Equality: use log space so ratios compare fairly
  const log = v => (v>0 ? Math.log(v) : NaN);
  const te_a = a.te ?? ((a.fn ?? 0) / Math.max(1e-9, a.fp ?? 0));
  const te_b = b.te ?? ((b.fn ?? 0) / Math.max(1e-9, b.fp ?? 0));
  const te_gap = Math.abs((log(te_a) ?? 0) - (log(te_b) ?? 0)); // gap in log-TE

  return { eo: eo_gap, ppv: ppv_gap, fpr: fpr_gap, ppr: ppr_gap, tpr: tpr_gap, te: te_gap };
}

// === OVERLAY BAR CHART (Before vs After status-score-eq) =====================
// === CONFIG: how to aggregate gaps across 3+ groups =========================
// "max" | "mean" | "wmean"  (size-weighted mean using group counts)
window.GAP_AGG_MODE = window.GAP_AGG_MODE || "max";

// Safe TE if per-group .te not present
function _safeTE(m){ const fn=(m?.fn??0), fp=(m?.fp??0); return fp>0 ? fn/fp : NaN; }

// Build per-group metrics map for current group key
// Build per-group metrics map from CURRENT Sankey groups.
// If a real column exists in the rows, we use it; otherwise we match by label.
function _perGroupMetricsAny(rows, groupKey, thr){
  const out = new Map();

  // A) Try column-based grouping iff the column actually exists on many rows
  const hasCol = rows.length && rows.some(r => Object.prototype.hasOwnProperty.call(r, groupKey));
  if (hasCol) {
    const byG = d3.group(rows, r => r[groupKey]);
    for (const [g, arr] of byG) {
      if (!g || !arr?.length) continue;
      const m = confusionAndFairness(arr, thr);
      m._n = arr.length;
      out.set(String(g), m);
    }
    if (out.size >= 2) return out;   // good enough
  }

  // B) Label-based (Sankey) grouping: use the visible group node labels
  const names = (window.LAST_GROUP_NAMES || []).slice();
  for (const gname of names) {
    const slice = rows.filter(r => rowMatchesGroup(r, gname));
    if (!slice.length) continue;
    const m = confusionAndFairness(slice, thr);
    m._n = slice.length;
    out.set(gname, m);
  }
  return out;
}


// Generic pairwise aggregator over groups
function _aggPairwiseGap(mByG, getter, mode){
  const keys = Array.from(mByG.keys());
  if (keys.length < 2) return 0;

  let acc = 0, wacc = 0, k = 0, best = 0;
  for (let i=0;i<keys.length;i++){
    for (let j=i+1;j<keys.length;j++){
      const gi = keys[i], gj = keys[j];
      const mi = mByG.get(gi), mj = mByG.get(gj);
      const vi = getter(mi), vj = getter(mj);
      if (!(Number.isFinite(vi) && Number.isFinite(vj))) continue;
      const gap = Math.abs(vi - vj);
      const w = (mi?._n ?? 1) + (mj?._n ?? 1);
      best = Math.max(best, gap);
      acc += gap; wacc += gap * w; k++;
    }
  }
  if (!k) return 0;
  if (mode === "max")   return best;
  if (mode === "wmean") return wacc / (2 * k); // average with crude size weight
  return acc / k; // mean
}

// Compute multi-group gaps for all metrics (EO uses TPR+FPR; TE uses log)
// function computeMultiGroupGaps(rows, groupKey, thr, mode){
//   const M = _perGroupMetricsAny(rows, groupKey, thr);

//   const tpr_gap = _aggPairwiseGap(M, m => m.tpr ?? NaN, mode);
//   const fpr_gap = _aggPairwiseGap(M, m => m.fpr ?? NaN, mode);
//   const ppv_gap = _aggPairwiseGap(M, m => m.ppv ?? NaN, mode);
//   const ppr_gap = _aggPairwiseGap(M, m => m.ppr ?? NaN, mode);

//   // EO as max/mean/wmean over pairwise of the **component gaps**:
//   // do it by aggregating pairwise Euclidean OR max; keep it simple with max of components per pair
//   const eo_gap = _aggPairwiseGap(M, m => m.tpr ?? NaN, mode); // start with TPR
//   const eo_gap_fpr = _aggPairwiseGap(M, m => m.fpr ?? NaN, mode);
//   const EO = (mode === "max") ? Math.max(eo_gap, eo_gap_fpr)
//                               : (eo_gap + eo_gap_fpr) / 2; // average components for mean modes

//   // TE in log-space
//   const te_gap = _aggPairwiseGap(M, m => {
//     const te = m.te ?? _safeTE(m);
//     return Number.isFinite(te) && te>0 ? Math.log(te) : NaN;
//   }, mode);


//   return { eo: EO, ppv: ppv_gap, fpr: fpr_gap, ppr: ppr_gap, tpr: tpr_gap, te: te_gap };
// }
function computeMultiGroupGaps(rows, groupKey, thr, mode){
  const M = _perGroupMetricsAny(rows, groupKey, thr);

  // === Define each fairness metric correctly ===
  
  // 1. Equal Opportunity: TPR gap (TP/(TP+FN))
  const eo_gap = _aggPairwiseGap(M, m => m.tpr ?? NaN, mode);
  
  // 2. Predictive Parity: PPV gap (TP/(TP+FP))
  const pp_gap = _aggPairwiseGap(M, m => m.ppv ?? NaN, mode);
  
  // 3. Equalized Odds: max(TPR gap, FPR gap) — both TPR and FPR must be equal
  const tpr_gap = _aggPairwiseGap(M, m => m.tpr ?? NaN, mode);
  const fpr_gap = _aggPairwiseGap(M, m => m.fpr ?? NaN, mode);
  const eo_odds_gap = Math.max(tpr_gap, fpr_gap);  // or use L2: Math.hypot(tpr_gap, fpr_gap)
  
  // 4. Demographic Parity: Predicted positive rate gap ((TP+FP)/(total))
  const dp_gap = _aggPairwiseGap(M, m => m.ppr ?? NaN, mode);
  
  // 5. Predictive Equality: FPR gap (FP/(FP+TN))
  const pe_gap = _aggPairwiseGap(M, m => m.fpr ?? NaN, mode);
  
  // 6. Treatment Equality: FN/FP ratio gap (in log-space)
  const te_gap = _aggPairwiseGap(M, m => {
    const te = m.te ?? _safeTE(m);
    return Number.isFinite(te) && te > 0 ? Math.log(te) : NaN;
  }, mode);

  return { 
    equal_opportunity: eo_gap,
    predictive_parity: pp_gap,
    equalized_odds: eo_odds_gap,
    demographic_parity: dp_gap,
    predictive_equality: pe_gap,
    treatment_equality: te_gap
  };
}

// Add this function to render baseline counts on initial load

function renderBaselineCountsChart() {
  const wrap = d3.select("#pcp-slice-summary");
  wrap.selectAll("*").remove();

  if (!state || !state.data || !state.data.length) {
    wrap.append("div").attr("class","muted")
      .text("Waiting for data...");
    return;
  }

  const groups = (window.LAST_GROUP_NAMES || []).slice();
  if (!groups.length) {
    wrap.append("div").attr("class","muted")
      .text("No groups available. Select protected attributes first.");
    return;
  }

  // --- Compute per-group confusion matrices (ALL DATA) ---
  const perGroupData = groups.map(g => {
    const groupRows = state.data.filter(r => rowMatchesGroup(r, g));
    let tp=0, fp=0, tn=0, fn=0;
    groupRows.forEach(r => {
      const gt  = +r.true_label;
      const pr  = +r.prediction;
      if (gt===1 && pr===1) tp++;
      else if (gt===0 && pr===1) fp++;
      else if (gt===0 && pr===0) tn++;
      else if (gt===1 && pr===0) fn++;
    });
    return {
      group: g,
      tp, fp, tn, fn,
      total: tp + fp + tn + fn
    };
  }).filter(d => d.total > 0);

  if (!perGroupData.length) {
    wrap.append("div").attr("class","muted")
      .text("No data matches selected groups.");
    return;
  }

  // --- Render stacked bar chart with PERCENTAGES ---
  const M = { t: 30, r: 12, b: 80, l: 50 };
  const W = Math.max(300, wrap.node()?.clientWidth || 400);
  const H = 240;
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;

  const svg = wrap.append("svg")
    .attr("width", W)
    .attr("height", H)
    .style("display", "block");

  const g = svg.append("g").attr("transform", `translate(${M.l},${M.t})`);

  // X scale: groups
  const x = d3.scaleBand()
    .domain(perGroupData.map(d => d.group))
    .range([0, innerW])
    .padding(0.5);

  // Y scale: 0-100% instead of counts
  const y = d3.scaleLinear()
    .domain([0, 100])
    .range([innerH, 0]);

  // Color scale for confusion outcomes
  const outcomeColors = {
    TP: "#2ca02c", // green
    FP: "#d62728", // red
    TN: "#1f77b4", // blue
    FN: "#9467bd"  // purple
  };

  // Convert to percentage and prepare stacked data
  const stackData = perGroupData.map(d => {
    const total = d.tp + d.fp + d.tn + d.fn;
    return {
      group: d.group,
      TP: (d.tp / total) * 100,
      FP: (d.fp / total) * 100,
      TN: (d.tn / total) * 100,
      FN: (d.fn / total) * 100,
      counts: { tp: d.tp, fp: d.fp, tn: d.tn, fn: d.fn, total }
    };
  });

  const stack = d3.stack()
    .keys(["TP", "FP", "TN", "FN"])
    .order(d3.stackOrderNone);

  const stackedData = stack(stackData);

  // --- Draw stacked bars ---
  const layers = g.selectAll("g.layer")
    .data(stackedData)
    .join("g")
      .attr("class", "layer")
      .attr("fill", d => outcomeColors[d.key]);

  layers.selectAll("rect")
    .data(d => d.map((v, i) => ({ ...v, outcome: d.key, dataIdx: i })))
    .join("rect")
      .attr("x", d => x(stackData[d.dataIdx].group))
      .attr("y", d => y(d[1]))
      .attr("width", x.bandwidth())
      .attr("height", d => y(d[0]) - y(d[1]))
      .attr("stroke", "#fff")
      .attr("stroke-width", 0.5)
      .append("title")
        .text(d => {
          const data = stackData[d.dataIdx];
          const pct = d[1] - d[0];
          const count = data.counts[d.outcome.toLowerCase()];
          return `${data.group}\n${d.outcome}: ${count} (${pct.toFixed(1)}%)`;
        });

  // --- Axes ---
  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x))
    .selectAll("text")
      .style("text-anchor", "end")
      .attr("dx", "-0.4em")
      .attr("dy", "0.35em")
      .attr("transform", "rotate(-25)")
      .style("font-size", "11px");

  g.append("g")
    .call(d3.axisLeft(y).ticks(5))
    .selectAll("text")
      .style("font-size", "10px");

  g.append("text")
    .attr("x", -innerH / 2)
    .attr("y", -40)
    .attr("text-anchor", "middle")
    .attr("transform", "rotate(-90)")
    .style("font-size", "11px")
    .style("font-weight", "600")
    .text("Percentage (%)");

  // --- Legend with 2x2 grid (CONSISTENT with renderSliceMetrics) ---
  const outcomes = ["TP", "FP", "TN", "FN"];
  const outcomeLabels = {
    TP: "True Positive",
    FP: "False Positive",
    TN: "True Negative",
    FN: "False Negative"
  };

  // 2 columns, wraps to 2 rows
  const LEG_COLS = 2;
  const LEG_SPACING_X = 90;
  const LEG_SPACING_Y = 14;

  // Compute legend width and position from right
  const legendWidth = (LEG_COLS - 1) * LEG_SPACING_X + 80;
  const legX = innerW - legendWidth-100;
  const legY = innerH + 30;

  const leg = g.append("g")
    .attr("transform", `translate(${legX},${legY})`);

  const legItems = leg.selectAll("g.leg-item")
    .data(outcomes)
    .join("g")
      .attr("class", "leg-item")
      .attr("transform", (d, i) => {
        const col = i % LEG_COLS;
        const row = Math.floor(i / LEG_COLS);
        return `translate(${col * LEG_SPACING_X}, ${row * LEG_SPACING_Y})`;
      });

  legItems.append("rect")
    .attr("width", 10)
    .attr("height", 10)
    .attr("fill", d => outcomeColors[d])
    .attr("stroke", "#333")
    .attr("stroke-width", 0.5);

  legItems.append("text")
    .attr("x", 14)
    .attr("y", 9)
    .style("font-size", "10px")
    .text(d => outcomeLabels[d]);

  // --- Summary stats footer ---
  const totalRows = d3.sum(perGroupData, d => d.total);
  const totalTP = d3.sum(perGroupData, d => d.tp);
  const totalFP = d3.sum(perGroupData, d => d.fp);
  const totalTN = d3.sum(perGroupData, d => d.tn);
  const totalFN = d3.sum(perGroupData, d => d.fn);

  svg.append("text")
    .attr("x", M.l)
    .attr("y", H - 8)
    .style("font-size", "10px")
    .style("fill", "#666")
    .text(`Total: ${totalRows} • TP: ${totalTP} FP: ${totalFP} TN: ${totalTN} FN: ${totalFN}`);
}

// Call this at the END of updateAll() to render baseline on initial load
// Add this line at the end of the updateAll() function:
// === OVERLAID GAPS CHART (Before vs After) =================================
function renderBaselineGapsSummary() {
  // const container = d3.select("#neutral-overall-metrics");
  // container.selectAll("*").remove();
  // container.append("div").attr("id","overall-gaps-chart");
  // overlay=false => only baseline bars
  renderOverallGapsOverlayMulti("#overall-gaps-chart", { overlay: false });
}


function renderOverallGapsOverlayMulti(containerSel, opts = {}) {
  const host = d3.select(containerSel);
  host.selectAll("*").remove();

  const overlayEnabled =
    (opts.overlay !== undefined) ? !!opts.overlay : !!(window.NEUTRAL && window.NEUTRAL.active);

  // --- data
  const thr = getThreshold();
  const groupKey = state.groupKey || window.CURRENT_GROUP_KEY || "age_bucket";

  // Baseline (BEFORE) is the pristine backup if it exists; otherwise current rows.
  const beforeRows = window.NEUTRAL?.backup ?? state.data;
  const afterRows  = state.data;

  const before = computeMultiGroupGaps(beforeRows, groupKey, thr, window.GAP_AGG_MODE);
  const after  = computeMultiGroupGaps(afterRows,  groupKey, thr, window.GAP_AGG_MODE);

  const rows = [
    { metric: "Equal Opportunity",    key: "equal_opportunity",    before: before.equal_opportunity,    after: after.equal_opportunity },
    { metric: "Predictive Parity",    key: "predictive_parity",    before: before.predictive_parity,    after: after.predictive_parity },
    { metric: "Equalized Odds",       key: "equalized_odds",       before: before.equalized_odds,       after: after.equalized_odds },
    { metric: "Demographic Parity",   key: "demographic_parity",   before: before.demographic_parity,   after: after.demographic_parity },
    { metric: "Predictive Equality",  key: "predictive_equality",  before: before.predictive_equality,  after: after.predictive_equality },
    { metric: "Treatment Equality",   key: "treatment_equality",   before: before.treatment_equality,   after: after.treatment_equality }
  ];

  // --- sizing
  const M = { t: 8, r: 10, b: 85, l: 60 };
  const containerW = Math.max(0, host.node()?.getBoundingClientRect()?.width || 0);
  const W = Math.max(320, ((opts.width ?? containerW) || 420));
  const H = opts.height ?? 220;
  const innerW = Math.max(1, W - M.l - M.r);
  const innerH = Math.max(1, H - M.t - M.b);

  const svg = host.append("svg").attr("width", W).attr("height", H).style("display","block");
  const g   = svg.append("g").attr("transform", `translate(${M.l},${M.t})`);

  const x = d3.scaleBand().domain(rows.map(d => d.metric)).range([0, innerW]).paddingInner(0.35);
  const ymax = d3.max(rows, d => Math.max(d.before ?? 0, overlayEnabled ? (d.after ?? 0) : 0)) || 1;
  const y = d3.scaleLinear().domain([0, ymax]).nice().range([innerH, 0]);

  g.append("g").attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x)).selectAll("text")
      .style("text-anchor","end").attr("dx","-0.4em").attr("dy","0.15em").attr("transform","rotate(-25)");
  g.append("g").call(d3.axisLeft(y).ticks(5));

  const MAX_BAR_W = 16;
  const bw = Math.min(MAX_BAR_W, x.bandwidth() * 0.55);
  const fmt = v => (v==null||isNaN(v)) ? "–" : d3.format(".3f")(v);

  // BEFORE (solid blue)
  g.selectAll("rect.before").data(rows).join("rect")
    .attr("class","before")
    .attr("x", d => x(d.metric) + (x.bandwidth() - bw) / 2)
    .attr("y", d => y(d.before ?? 0))
    .attr("width", bw)
    .attr("height", d => innerH - y(d.before ?? 0))
    .attr("rx", 4).attr("ry", 4)
    .style("fill", "#9bd")   
    .style("fill-opacity", 1) 
    .append("title").text(d => `Baseline gap: ${fmt(d.before)}`);

  // AFTER overlay only if enabled (semi-transparent red)
  if (overlayEnabled) {
    g.selectAll("rect.after").data(rows).join("rect")
      .attr("class","after")
      .attr("x", d => x(d.metric) + (x.bandwidth() - bw) / 2)
      .attr("y", d => y(d.after ?? 0))
      .attr("width", bw)
      .attr("height", d => innerH - y(d.after ?? 0))
      .attr("rx", 4).attr("ry", 4)
      .attr("fill", "#e66").attr("fill-opacity", 0.45)
      .attr("stroke", "currentColor").attr("stroke-width", 1.2)
      .append("title").text(d => `After gap: ${fmt(d.after)}`);
  }

  // Compact legend
  const LEG = { box: 8, fs: 15, x2: 75, y: 0 };
  const leg = g.append("g").attr("transform", `translate(0,${LEG.y})`).attr("font-size", LEG.fs);
  leg.append("rect").attr("width", LEG.box).attr("height", LEG.box).attr("fill", "#9bd");
  leg.append("text").attr("x", LEG.box + 6).attr("y", LEG.box - 1).text(overlayEnabled ? "Before" : "Baseline");

  if (overlayEnabled) {
    leg.append("rect")
      .attr("x", LEG.x2).attr("width", LEG.box).attr("height", LEG.box)
      .attr("fill", "#e66").attr("fill-opacity", 0.45).attr("stroke", "currentColor");
    leg.append("text").attr("x", LEG.x2 + LEG.box + 6).attr("y", LEG.box - 1).text("After");
  }

  svg.append("text")
    .attr("x", M.l).attr("y", H - 8).attr("font-size", 12)
    .text(`Gap aggregation: ${window.GAP_AGG_MODE}`);
}


function renderGroupBars(rows=null) {
  const host = d3.select("#group-bars");
  host.selectAll("*").remove();

  // ADD: Toggle buttons at the top (SMALLER)
  const controlsDiv = host.append("div")
    .style("margin-bottom", "8px")
    .style("display", "flex")
    .style("gap", "6px");

  controlsDiv.append("button")
    .attr("id", "btn-metric-by-group")
    .text("Metric by Group")
    .style("padding", "4px 8px")
    .style("font-size", "11px")
    .style("border", "1px solid #999")
    .style("background-color", groupBarsView === "metric-by-group" ? "#0078d4" : "#f0f0f0")
    .style("color", groupBarsView === "metric-by-group" ? "white" : "black")
    .style("cursor", "pointer")
    .style("border-radius", "3px")
    .on("click", () => {
      groupBarsView = "metric-by-group";
      renderGroupBars(rows);
    });

  controlsDiv.append("button")
    .attr("id", "btn-fairness-gap")
    .text("Δ Fairness Metrics")
    .style("padding", "4px 8px")
    .style("font-size", "11px")
    .style("border", "1px solid #999")
    .style("background-color", groupBarsView === "fairness-gap" ? "#0078d4" : "#f0f0f0")
    .style("color", groupBarsView === "fairness-gap" ? "white" : "black")
    .style("cursor", "pointer")
    .style("border-radius", "3px")
    .on("click", () => {
      groupBarsView = "fairness-gap";
      renderGroupBars(rows);
    });

  // Show appropriate chart based on selection
  if (groupBarsView === "fairness-gap") {
    renderFairnessGapsChart(host);
    return;
  }

  // ===== METRIC BY GROUP CHART (original code) =====
  const groups = (window.LAST_GROUP_NAMES || []).slice();
  if (!groups.length || !state?.data?.length || !GROUP_COLOR_SCALE) {
    host.append("div").attr("class","muted").style("padding","8px 4px")
        .text("No groups to display yet.");
    return;
  }

  const pool = (rows && rows.length) ? rows : state.data;
  const overall = computeSliceMetrics(pool);

  const eoScore = (s, ref = overall, mode = "max") => {
    const dTPR = Math.abs((s.tpr ?? 0) - (ref.tpr ?? 0));
    const dFPR = Math.abs((s.fpr ?? 0) - (ref.fpr ?? 0));
    return mode === "l2" ? Math.hypot(dTPR, dFPR) : Math.max(dTPR, dFPR);
  };
  const perGroup = groups.map(g => {
    const s = computeSliceMetrics(pool.filter(r => rowMatchesGroup(r, g)));
    return { group: g, s, eo: eoScore(s) };
  });
  const METRICS = [
    { id:"tpr", label:"Equal Opportunity",    short:"TPR" },
    { id:"ppv", label:"Predictive Parity",    short:"PPV" },
    { id:"eo",  label:"Equalized Odds",       short:"EO"  },
    { id:"ppr", label:"Demographic Parity",   short:"Pred+ rate" },
    { id:"fpr", label:"Predictive Equality",  short:"FPR" },
    { id:"te",  label:"Treatment Equality",   short:"FN/FP" },
  ];
  const bars = [];
  METRICS.forEach(m => {
    perGroup.forEach(g => {
      const v = (m.id === "eo") ? g.eo : g.s[m.id];
      bars.push({ metric: m.label, metricLong: m.label, group: g.group, value: v });
    });
  });

  const METRIC_COUNT = METRICS.length;
  const GROUP_COUNT  = groups.length;
  const MIN_BAR_W  = 8;  // Bar width (reduced from 10)
  const GAP_INNER  = 4;  // Gap between bars in same metric (reduced from 6)
  const GAP_METRIC = 14;  // Gap between metrics (reduced from 18)
  const M = { t: 15, r: 12, b: 50, l: 48 };  // Reduced top and bottom margins
  const CHART_H = 150;  // Chart height only (reduced from 205)
  const H = 210;  // SVG height (reduced from 280)

  const perMetricInner = GROUP_COUNT * MIN_BAR_W + Math.max(0, GROUP_COUNT - 1) * GAP_INNER;
  const neededInnerW   = METRIC_COUNT * perMetricInner + Math.max(0, METRIC_COUNT - 1) * GAP_METRIC;

  host.style("overflow-x", neededInnerW > 600 ? "auto" : null)
      .style("height", (H + 30) + "px")
      .style("border", "none")
      .style("box-shadow", "none")
      .style("outline", "none");

  const containerW = host.node().clientWidth || 520;
  const W = Math.max(containerW, neededInnerW + M.l + M.r);

  const wrap = host.append("div")
    .style("width",  W + "px")
    .style("height", H + "px")
    .style("border", "none");

  const svg  = wrap.append("svg").attr("width", W).attr("height", H).style("border", "none");
  const g    = svg.append("g").attr("transform", `translate(${M.l},${M.t})`);

  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;

  const xMetric = d3.scaleBand()
    .domain(METRICS.map(m => m.label))
    .range([0, innerW]).padding(0.15);

  const xGroup = d3.scaleBand()
    .domain(groups)
    .range([0, xMetric.bandwidth()]).padding(0.12);

  const yMax = d3.max(bars, d => Number.isFinite(d.value) ? d.value : 0) || 1;
  const y = d3.scaleLinear()
    .domain([0, Math.max(1e-9, yMax)]).nice()
    .range([innerH, 0]);

  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(xMetric))
    .selectAll("text").style("font-size","9px")
                      .style("text-anchor","end")
                      .attr("dx","-0.4em")
                      .attr("dy","0.35em")
                      .attr("transform","rotate(-30)");

  g.append("g")
    .call(d3.axisLeft(y).ticks(4))
    .selectAll("text").style("font-size","10px");

  g.append("text")
    .attr("x", 0).attr("y", -8).attr("fill", "#111")
    .style("font-weight", 600).style("font-size", "11px")
    .text("Score");

  const metricGroups = g.selectAll(".metric-group")
    .data(xMetric.domain())
    .join("g")
      .attr("class", "metric-group")
      .attr("transform", d => `translate(${xMetric(d)},0)`);

  metricGroups.selectAll("rect")
    .data(metric => bars.filter(b => b.metric === metric))
    .join("rect")
      .attr("x", d => xGroup(d.group))
      .attr("y", d => Number.isFinite(d.value) ? y(Math.max(0, d.value)) : y(0))
      .attr("width", xGroup.bandwidth())
      .attr("height", d => Number.isFinite(d.value) ? (innerH - y(Math.max(0, d.value))) : 0)
      .attr("fill", d => GROUP_COLOR_SCALE(d.group))
    .append("title")
      .text(d => `${d.group}\n${d.metricLong}: ${
        (d.value != null && isFinite(d.value)) ? d3.format(".3f")(d.value) : "–"
      }`);
}


// 4. ADD THIS NEW FUNCTION to render fairness gaps chart:

function renderFairnessGapsChart(host) {
  const containerSel = host.append("div")
    .attr("id", "fairness-gaps-container")
    .style("height", "307px");

  renderOverallGapsOverlayMulti("#fairness-gaps-container", { 
    overlay: !!(window.NEUTRAL && window.NEUTRAL.active),
    width: host.node().clientWidth || 520,
    height: 280
  });
}

function updateMetricEquation() {
  const m = currentMetric;

  // Helper function to create colored span for outcome terms
  const colorTerm = (term) => {
    if (OUTCOME_COLORS[term]) {
      return `<span style="color: ${OUTCOME_COLORS[term]}; font-weight: bold;">${term}</span>`;
    }
    return term;
  };

  // Metric definitions
  const definitions = {
    "equal_opportunity": "Measures whether all groups have equal true positive rates (sensitivity)",
    "predictive_parity": "Measures whether positive predictions are equally accurate across groups",
    "predictive_equality": "Measures whether all groups have equal false positive rates",
    "demographic_parity": "Measures whether all groups receive positive predictions at equal rates",
    "equalized_odds": "Requires both equal true positive and false positive rates across groups",
    "treatment_equality": "Measures the ratio of errors (false negatives to false positives) across groups"
  };

  // For equalized odds, just show a general description without component selection
  let equation;
  if (!m) {
    // No metric selected - show instruction
    equation = `<span style="color: #999; font-style: italic;">Select a metric to view equation...</span>`;
  } else {
    switch (m) {
      case "equal_opportunity":     // TPR
        equation = `TPR = ${colorTerm('TP')} / (${colorTerm('TP')} + ${colorTerm('FN')})`;
        break;
      case "predictive_parity":     // PPV
        equation = `PPV = ${colorTerm('TP')} / (${colorTerm('TP')} + ${colorTerm('FP')})`;
        break;
      case "predictive_equality":   // FPR
        equation = `FPR = ${colorTerm('FP')} / (${colorTerm('FP')} + ${colorTerm('TN')})`;
        break;
      case "demographic_parity":    // Predicted-positive rate
        equation = `PPR = (${colorTerm('TP')} + ${colorTerm('FP')}) / (${colorTerm('TP')} + ${colorTerm('FP')} + ${colorTerm('TN')} + ${colorTerm('FN')})`;
        break;
      case "equalized_odds":        // show both components
        equation = `Equalized Odds: TPR = ${colorTerm('TP')} / (${colorTerm('TP')} + ${colorTerm('FN')}) AND FPR = ${colorTerm('FP')} / (${colorTerm('FP')} + ${colorTerm('TN')})`;
        break;
      case "treatment_equality":    // FN/FP
        equation = `Treatment Equality = ${colorTerm('FN')} / ${colorTerm('FP')}`;
        break;
      default:
        equation = "";
    }
  }

  d3.select("#metric-equation").html(equation);

  // Show/hide help button and definition
  if (m && definitions[m]) {
    d3.select("#metric-help-btn").style("display", "block");
    d3.select("#metric-definition").html(definitions[m]);
  } else {
    d3.select("#metric-help-btn").style("display", "none");
    d3.select("#metric-definition").style("display", "none");
  }
}

// =============================== NEUTRALIZATION ================================
// --- tiny deep clone for row arrays (uses structuredClone when available) ---
function deepCloneRows(rows) {
  if (typeof structuredClone === "function") return structuredClone(rows);
  // fallback: safe for plain objects/arrays/numbers/strings
  return rows.map(r => JSON.parse(JSON.stringify(r)));
}
// ---------- Quantile-mapping helpers (used by neutralization) ----------
function _sortedCopy(arr){
  // numeric ascending, filter non-finite
  return arr.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
}

// Inverse-CDF for a pre-sorted numeric array at probability p∈[0,1].
// Linear interpolation between order statistics.
function _qFromP(sorted, p){
  if (!sorted.length) return NaN;
  const n = sorted.length;
  const pp = Math.min(1, Math.max(0, p));
  if (n === 1) return sorted[0];
  const idx = (n - 1) * pp;
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] + t * (sorted[hi] - sorted[lo]);
}

// Empirical CDF value F(y) for a pre-sorted numeric array (right-continuous).
// Returns the fraction of values ≤ y (i.e., rank / n).
function _ecdfP(sorted, y){
  const n = sorted.length || 1;
  // upper_bound: first index with sorted[i] > y
  let lo = 0, hi = sorted.length;
  while (lo < hi){
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= y) lo = mid + 1; else hi = mid;
  }
  return lo / n;
}

/**
 * Get checked protected attributes from the checkboxes (age, gender, marital_status)
 */
function getCheckedProtectedAttributes() {
  const checked = [];
  d3.selectAll("#feature-options input[type=checkbox]:checked").each(function() {
    checked.push(this.id);
  });
  return checked;
}

/**
 * NEW: Resolve neutralization scope with updated logic
 *
 * Priority order:
 * 1. If subgroups selected from confusion bars (streams) => neutralize only those subgroups
 * 2. Default: All rows, grouped by the checked protected attributes
 *
 * Returns: { type: string, ids: Set, protectedAttrs: string[] }
 */
function resolveNeutralScope(){
  const protectedAttrs = getCheckedProtectedAttributes();

  // 1) Subgroups selected from confusion bars (streams)?
  if (window.streamSelections && window.streamSelections.size){
    const ids = new Set();
    for (const s of window.streamSelections.values()) s.ids.forEach(id => ids.add(id));
    return { type: "subgroups", ids, protectedAttrs };
  }

  // 2) Default: All rows, grouped by protected attributes
  return { type: "all_groups", ids: new Set(), protectedAttrs };
}
// features: string[], scopeIds: Set (empty => global)
/**
 * NEW: Feature Distribution Alignment - Categorical Features
 * Aligns the distribution of a categorical feature across groups
 *
 * @param {string} featureToAlign - The categorical feature to neutralize (e.g., 'status', 'checking_status')
 * @param {string[]} protectedAttrs - Protected attributes defining groups (e.g., ['age'])
 * @param {Set} scopeIds - Row IDs in scope (empty => all rows)
 */
function alignCategoricalFeature(featureToAlign, protectedAttrs, scopeIds) {
  const inScope = r => !scopeIds.size || scopeIds.has(r._id ?? r.id);

  // Build composite group key from protected attributes
  const getGroupKey = (row) => {
    return protectedAttrs.map(attr => row[attr] ?? 'null').join('|');
  };

  // Step 1: Collect feature value distributions by group
  const byGroup = new Map(); // groupKey -> { rows: [], valueCounts: Map }

  for (const r of state.data) {
    if (!inScope(r)) continue;
    const groupKey = getGroupKey(r);
    const featureVal = r[featureToAlign];
    if (featureVal == null) continue;

    if (!byGroup.has(groupKey)) {
      byGroup.set(groupKey, { rows: [], valueCounts: new Map() });
    }

    const groupData = byGroup.get(groupKey);
    groupData.rows.push(r);
    groupData.valueCounts.set(featureVal, (groupData.valueCounts.get(featureVal) || 0) + 1);
  }

  if (byGroup.size === 0) return;

  // Step 2: Compute target distribution (pooled across all groups)
  const targetCounts = new Map();
  let targetTotal = 0;

  for (const {valueCounts} of byGroup.values()) {
    for (const [val, count] of valueCounts) {
      targetCounts.set(val, (targetCounts.get(val) || 0) + count);
      targetTotal += count;
    }
  }

  // Convert to probabilities
  const targetDist = new Map();
  for (const [val, count] of targetCounts) {
    targetDist.set(val, count / targetTotal);
  }

  // Step 3: For each group, reassign feature values to match target distribution
  for (const [groupKey, {rows}] of byGroup) {
    if (rows.length === 0) continue;

    // Calculate how many of each value we need in this group
    const targetAssignments = new Map();
    const allValues = Array.from(targetDist.keys());

    for (const val of allValues) {
      const targetProb = targetDist.get(val);
      const targetCount = Math.round(targetProb * rows.length);
      targetAssignments.set(val, targetCount);
    }

    // Adjust for rounding (make sure total equals rows.length)
    let totalAssigned = Array.from(targetAssignments.values()).reduce((a, b) => a + b, 0);
    if (totalAssigned !== rows.length && allValues.length > 0) {
      const diff = rows.length - totalAssigned;
      const firstVal = allValues[0];
      targetAssignments.set(firstVal, targetAssignments.get(firstVal) + diff);
    }

    // Create assignment array
    const newValues = [];
    for (const [val, count] of targetAssignments) {
      for (let i = 0; i < count; i++) {
        newValues.push(val);
      }
    }

    // Shuffle to randomize assignment
    for (let i = newValues.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newValues[i], newValues[j]] = [newValues[j], newValues[i]];
    }

    // Assign new values
    for (let i = 0; i < rows.length && i < newValues.length; i++) {
      const r = rows[i];
      if (!r._neutral_features) r._neutral_features = {};
      r._neutral_features[featureToAlign] = newValues[i];
    }
  }
}

/**
 * NEW: Feature Distribution Alignment - Numerical Features
 * Aligns the distribution of a numerical feature across groups using quantile mapping
 *
 * @param {string} featureToAlign - The numerical feature to neutralize (e.g., 'duration', 'credit_amount')
 * @param {string[]} protectedAttrs - Protected attributes defining groups
 * @param {Set} scopeIds - Row IDs in scope (empty => all rows)
 */
function alignNumericalFeature(featureToAlign, protectedAttrs, scopeIds) {
  const inScope = r => !scopeIds.size || scopeIds.has(r._id ?? r.id);

  // Build composite group key from protected attributes
  const getGroupKey = (row) => {
    return protectedAttrs.map(attr => row[attr] ?? 'null').join('|');
  };

  // Step 1: Collect feature values by group
  const byGroup = new Map(); // groupKey -> { values: [], rows: [] }

  for (const r of state.data) {
    if (!inScope(r)) continue;
    const groupKey = getGroupKey(r);
    const featureVal = r[featureToAlign];
    if (featureVal == null || isNaN(+featureVal)) continue;

    if (!byGroup.has(groupKey)) {
      byGroup.set(groupKey, { values: [], rows: [] });
    }

    byGroup.get(groupKey).values.push(+featureVal);
    byGroup.get(groupKey).rows.push(r);
  }

  if (byGroup.size === 0) return;

  // Step 2: Compute target distribution (pooled)
  const allValues = [];
  for (const {values} of byGroup.values()) {
    allValues.push(...values);
  }
  const targetSorted = _sortedCopy(allValues);
  if (targetSorted.length === 0) return;

  // Step 3: For each group, apply quantile mapping
  for (const [groupKey, {values, rows}] of byGroup) {
    const groupSorted = _sortedCopy(values);
    if (groupSorted.length === 0) continue;

    for (const r of rows) {
      const x = +r[featureToAlign];

      // u = F_group(x) - quantile in this group's distribution
      const u = _ecdfP(groupSorted, x);

      // x' = F_target^{-1}(u) - same quantile in target distribution
      const xPrime = _qFromP(targetSorted, u);

      if (!r._neutral_features) r._neutral_features = {};
      r._neutral_features[featureToAlign] = xPrime;
    }
  }
}

/**
 * NEW: Main neutralization function - aligns feature distributions across groups
 *
 * @param {string[]} featuresToAlign - Features selected from PCP to neutralize
 * @param {string[]} protectedAttrs - Protected attributes defining groups (from checkboxes)
 * @param {Set} scopeIds - Row IDs in scope (empty => all rows)
 */
function neutralizeFeatureDistributions(featuresToAlign, protectedAttrs, scopeIds) {
  if (featuresToAlign.length === 0) {
    console.warn("No features selected to neutralize");
    return;
  }

  if (protectedAttrs.length === 0) {
    console.warn("No protected attributes selected - cannot define groups");
    return;
  }

  console.log("Neutralizing features:", featuresToAlign);
  console.log("Across protected attribute groups:", protectedAttrs);

  // Detect which features are numeric vs categorical
  const numericSet = new Set(state.numericKeys || []);

  for (const feature of featuresToAlign) {
    // Skip if feature is same as protected attribute
    if (protectedAttrs.includes(feature)) {
      console.log(`Skipping ${feature} - it's a protected attribute`);
      continue;
    }

    const isNumeric = numericSet.has(feature);

    if (isNumeric) {
      console.log(`Aligning numerical feature: ${feature}`);
      alignNumericalFeature(feature, protectedAttrs, scopeIds);
    } else {
      console.log(`Aligning categorical feature: ${feature}`);
      alignCategoricalFeature(feature, protectedAttrs, scopeIds);
    }
  }
}

/**
 * Wrapper to maintain compatibility with existing code
 */
function neutralizeScoresByQuantileBarycenter(features, scopeIds){
  // Get protected attributes from checkboxes
  const protectedAttrs = getCheckedProtectedAttributes();

  // Call new feature distribution alignment
  neutralizeFeatureDistributions(features, protectedAttrs, scopeIds);
}
function getThreshold(){ return +currentThr || 0.5; }

// uses score_neutral if present; else falls back to original score
function recomputePredictionsInPlace(thr){
  for (const r of state.data){
    const s = (r.score_neutral ?? r.score ?? 0);
    r.prediction = (s >= thr) ? 1 : 0;
  }
}
function confusionAndFairness(rows, thr){
  // ensure predictions obey thr for these rows
  // (they will, after recomputePredictionsInPlace)
  return computeSliceMetrics(rows);
}

function currentScopeRows(scopeIds, data = state.data){
  if (!scopeIds || !scopeIds.size) return data;
  return data.filter(r => scopeIds.has(r._id ?? r.id));
}

function metricDelta(after, before){
  const keys = ["tp","fp","tn","fn","tpr","fpr","ppv","ppr","te","eo"];
  const out = {};
  for (const k of keys) out[k] = (after[k] ?? NaN) - (before[k] ?? NaN);
  return out;
}

/**
 * Call backend /repredict endpoint to get new scores for neutralized data
 */
async function repredictWithNeutralizedFeatures() {
  try {
    const response = await fetch("/repredict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: state.data })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    const newScores = result.scores;

    // Update scores in data
    for (let i = 0; i < state.data.length && i < newScores.length; i++) {
      state.data[i].score_neutral = newScores[i];
    }

    console.log("Successfully recomputed predictions with neutralized features");
  } catch (error) {
    console.error("Error repredicting:", error);
    notify("Error recomputing predictions: " + error.message);
  }
}

async function applyNeutralization(){
  const sc  = resolveNeutralScope();
  const feats = getSelectedNeutralizeFeatures();
  if (!feats.length) { notify("Pick ≥1 feature to neutralize."); return; }

  // freeze pristine backup once
  if (!window.NEUTRAL) window.NEUTRAL = {};
  if (!window.NEUTRAL.backup) window.NEUTRAL.backup = deepCloneRows(state.data);

  // REBASE to pristine each Apply
  state.data = deepCloneRows(window.NEUTRAL.backup);

  const thr = getThreshold();

  // ===== CRITICAL FIX: Snapshot BEFORE using original scores =====
  for (const r of state.data) {
    if (r.score !== undefined) {
      r.prediction = (r.score >= thr) ? 1 : 0;
    }
  }

  const scopeBefore = confusionAndFairness(currentScopeRows(sc.ids, state.data), thr);
  const allBefore   = confusionAndFairness(state.data, thr);

  // ===== Save original Sankey data for comparison in confusion bars =====
  // This must happen BEFORE any neutralization is applied to state.data
  const protStr = Array.isArray(currentProtected)
    ? currentProtected.join(",")
    : currentProtected;

  // Fetch and save original data structure for confusion bars
  const originalDataResponse = await d3.json(
    `${API_ROOT}/sankey?metric=${currentMetric}` +
    `&protected=${protStr}&thr=${currentThr}`
  );
  window.NEUTRAL.originalData = originalDataResponse;

  // Also save a copy of the original state.data before neutralization
  window.NEUTRAL.originalStateData = deepCloneRows(state.data);

  // ===== Apply neutralization (feature distribution alignment) =====
  neutralizeScoresByQuantileBarycenter(feats, sc.ids);

  // ===== Apply neutralized features to data rows =====
  for (const r of state.data) {
    if (r._neutral_features) {
      // Apply neutralized feature values
      for (const [feat, value] of Object.entries(r._neutral_features)) {
        r[feat] = value;
      }
    }
  }

  // ===== Call backend to recompute predictions with neutralized features =====
  await repredictWithNeutralizedFeatures();

  // ===== Recompute predictions from new scores =====
  for (const r of state.data) {
    const scoreToUse = (r.score_neutral !== undefined) ? r.score_neutral : r.score;
    r.prediction = (scoreToUse >= thr) ? 1 : 0;
  }

  // ===== Snapshot AFTER using new predictions =====
  const scopeAfter = confusionAndFairness(currentScopeRows(sc.ids, state.data), thr);
  const allAfter   = confusionAndFairness(state.data, thr);

  // deltas
  const scopeΔ = metricDelta(scopeAfter, scopeBefore);
  const allΔ   = metricDelta(allAfter, allBefore);

  // SET FLAG BEFORE RENDERING
  window.NEUTRAL.active = true;
  window.NEUTRAL.scope  = sc;
  window.NEUTRAL.features = feats;

  // NOW render the chart with the flag already set
  renderNeutralizationSummary({
    scope: { before: scopeBefore, after: scopeAfter, delta: scopeΔ, label: sc.type },
    overall: { before: allBefore, after: allAfter, delta: allΔ }
  }, feats);

  // rerender visuals
  updateLinkLegend();
  renderGroupBars();
  renderPCP();
  
  // ===== UPDATE PCP SLICE CHART WITH NEW BASELINE =====
  renderBaselineCountsChart();
  // NEW: Set flag to prevent drawSankey from overwriting group bars
  window._skipGroupBarsRender = true;

  // NEW: Update Sankey with post-neutralization column
  updateSankeyForNeutralization();

  // enable Revert
  d3.select("#btn-revert-neutral").attr("disabled", null);
}


function revertNeutralization(){
  // Restore from pristine backup (which has original scores)
  if (window.NEUTRAL?.backup) {
    state.data = deepCloneRows(window.NEUTRAL.backup);
  }

  // Clean up neutralization state
  window.NEUTRAL = { active: false, backup: null, scope: null, features: [] };
  
  // Clear selected features and their highlighting
  window.neutralizationFeatures.clear();
  updateNeutralizationDisplay();
  updatePcpAxisStyles();

  // Ensure predictions are recomputed from ORIGINAL scores at current threshold
  const thr = getThreshold();
  for (const r of state.data) {
    // Delete any neutralized score
    delete r.score_neutral;
    // Recompute prediction from original score
    if (r.score !== undefined) {
      r.prediction = (r.score >= thr) ? 1 : 0;
    }
  }

  // Re-render baseline gaps chart (blue bars only, no overlay)
  renderBaselineGapsSummary();
  //renderGroupBars();
  updateLinkLegend();
  renderPCP();
  
  // ===== UPDATE PCP SLICE CHART BACK TO ORIGINAL BASELINE =====
  renderBaselineCountsChart();
  // NEW: Revert Sankey to 3-column view
  updateSankeyForNeutralization();

  // Disable revert button
  d3.select("#btn-revert-neutral").attr("disabled", true);
}

function renderNeutralizationSummary(payload, features){
  const host = d3.select("#summary-panel .content");
  host.selectAll("#neutralization-summary").remove();
  const box = host.append("div").attr("id","neutralization-summary");

  const fmt = d3.format(".3f");
  function addBlock(title, snap){
    const {before, after, delta} = snap;
    const k1 = ["tp","fp","tn","fn"], k2 = ["tpr","fpr","ppv","ppr","eo","te"];
    box.append("h4").text(title);
    const tbl = box.append("table").attr("class","compact");
    tbl.append("tr").html("<th>Metric</th><th>Before</th><th>After</th><th>Δ</th>");
    function row(k, lab){
      const b = before[k], a = after[k], d = delta[k];
      const f = (v, isInt=false) => (v==null||isNaN(v)) ? "—" : (isInt? d3.format(",")(v) : fmt(v));
      tbl.append("tr").html(
        `<td>${lab}</td><td>${f(b, k1.includes(k))}</td><td>${f(a, k1.includes(k))}</td><td>${f(d)}</td>`
      );
    }
    k1.forEach(k => row(k, k.toUpperCase()));
    k2.forEach(k => row(k, k.toUpperCase()));
  }

  renderOverallGapsOverlayMulti("#overall-gaps-chart"); // auto-reads current grouping
}

function clearNeutralizationSummary(){
  d3.select("#neutralization-summary").remove();
}
// Helper: TP/FP/TN/FN for a row (reuses your existing logic if present)
function outcomeOfRow(r) {
  if (typeof rowOutcome === 'function') return rowOutcome(r);
  const y = +r.true_label;
  const p = +r.prediction;
  if (y === 1 && p === 1) return 'TP';
  if (y === 0 && p === 1) return 'FP';
  if (y === 0 && p === 0) return 'TN';
  if (y === 1 && p === 0) return 'FN';
  return null;
}

// Build a 4×4 matrix: before → after
function computeOutcomeTransitions(beforeRows, afterRows) {
  const byId = new Map();
  for (const r of beforeRows) {
    const id = r._id ?? r.id;
    if (id != null) byId.set(id, r);
  }

  const labels = ['TP', 'FP', 'TN', 'FN'];
  const matrix = {};
  for (const a of labels) {
    matrix[a] = {};
    for (const b of labels) matrix[a][b] = 0;
  }

  let total = 0;

  for (const rAfter of afterRows) {
    const id = rAfter._id ?? rAfter.id;
    const rBefore = byId.get(id);
    if (!rBefore) continue;

    const before = outcomeOfRow(rBefore);
    const after  = outcomeOfRow(rAfter);
    if (!before || !after) continue;

    matrix[before][after] += 1;
    total += 1;
  }

  return { matrix, totalRows: total };
}

function transformDataForNeutralizedSankey(originalData) {
  // If neutralization is NOT active, return original data unchanged
  if (!window.NEUTRAL || !window.NEUTRAL.active || !window.NEUTRAL.backup) {
    return originalData;
  }

  // Compute transitions: before (backup) → after (current state.data)
  const beforeRows = window.NEUTRAL.backup;
  const afterRows = state.data;
  const { matrix, totalRows } = computeOutcomeTransitions(beforeRows, afterRows);

  // Clone original nodes and links
  const nodes = originalData.nodes.map(n => ({ ...n }));
  const links = originalData.links.map(l => ({ ...l }));

  // Find the indices of outcome nodes
  const outcomeNames = ["TP", "FP", "TN", "FN"];
  const outcomeIndices = {};
  nodes.forEach((n, i) => {
    if (outcomeNames.includes(n.name)) {
      outcomeIndices[n.name] = i;
    }
  });

  // Add post-neutralization nodes (layer 4)
  const postNodes = outcomeNames.map(name => ({
    name: `${name}'`,  // e.g., TP', FP', TN', FN'
    isPostNeutral: true,
    originalOutcome: name
  }));
  
  const postStartIndex = nodes.length;
  nodes.push(...postNodes);

  // Build post-node index map
  const postIndices = {};
  outcomeNames.forEach((name, i) => {
    postIndices[name] = postStartIndex + i;
  });

  // Add transition links from outcomes to post-outcomes
  outcomeNames.forEach(fromOutcome => {
    outcomeNames.forEach(toOutcome => {
      const count = matrix[fromOutcome]?.[toOutcome] || 0;
      if (count > 0) {
        links.push({
          source: outcomeIndices[fromOutcome],
          target: postIndices[toOutcome],
          value: count,
          isTransition: true,
          fromOutcome,
          toOutcome,
          // Flag if this is a "change" (different outcome)
          isChange: fromOutcome !== toOutcome
        });
      }
    });
  });

  return { nodes, links };
}
function updateSankeyForNeutralization() {
  if (!state.data || !state.data.length) return;

  const protStr = Array.isArray(currentProtected)
    ? currentProtected.join(",")
    : currentProtected;

  d3.json(
    `${API_ROOT}/sankey?metric=${currentMetric}` +
    `&protected=${protStr}&thr=${currentThr}`
  ).then(data => {
    const transformedData = transformDataForNeutralizedSankey(data);
    // Use confusion bars instead of Sankey
    drawConfusionBars(transformedData);
    updateLinkLegend();
  }).catch(err => console.error("Error updating visualization:", err));
}

// Helper: TP/FP/TN/FN for a row (reuses your existing logic if present)
function outcomeOfRow(r) {
  if (typeof rowOutcome === 'function') return rowOutcome(r);
  const y = +r.true_label;
  const p = +r.prediction;
  if (y === 1 && p === 1) return 'TP';
  if (y === 0 && p === 1) return 'FP';
  if (y === 0 && p === 0) return 'TN';
  if (y === 1 && p === 0) return 'FN';
  return null;
}

// Build a 4×4 matrix: before → after
function computeOutcomeTransitions(beforeRows, afterRows) {
  const byId = new Map();
  for (const r of beforeRows) {
    const id = r._id ?? r.id;
    if (id != null) byId.set(id, r);
  }

  const labels = ['TP', 'FP', 'TN', 'FN'];
  const matrix = {};
  for (const a of labels) {
    matrix[a] = {};
    for (const b of labels) matrix[a][b] = 0;
  }

  let total = 0;

  for (const rAfter of afterRows) {
    const id = rAfter._id ?? rAfter.id;
    const rBefore = byId.get(id);
    if (!rBefore) continue;

    const before = outcomeOfRow(rBefore);
    const after  = outcomeOfRow(rAfter);
    if (!before || !after) continue;

    matrix[before][after] += 1;
    total += 1;
  }

  return { matrix, totalRows: total };
}

function buildNeutralizeFeatureList() {
  // Neutralization selection now happens via PCP axis clicks
  // Initialize the display
  updateNeutralizationDisplay();
}

// Track neutralization feature selections from PCP axis clicks
window.neutralizationFeatures = window.neutralizationFeatures || new Set();
function updateNeutralizationDisplay() {
  const container = d3.select("#neutralize-selected-features");
  container.selectAll("*").remove();

  if (!window.neutralizationFeatures || window.neutralizationFeatures.size === 0) {
    container.append("span").attr("class", "muted").style("font-size", "10px").text("None");
    return;
  }

  const features = Array.from(window.neutralizationFeatures).sort();
  container.selectAll("div.neutralize-chip")
    .data(features)
    .join("div")
      .attr("class", "neutralize-chip")
      .html(d => `${d} <span class="remove-chip">×</span>`)
      .on("click", (event, d) => {
        event.stopPropagation();
        window.neutralizationFeatures.delete(d);
        updateNeutralizationDisplay();
        updatePcpAxisStyles();
      });
}

/**
 * Update the visual style of axis titles based on selection state
 */
function updatePcpAxisStyles() {
  d3.selectAll(".axis-title").each(function(d) {
    const sel = d3.select(this);
    const isSelected = window.neutralizationFeatures && window.neutralizationFeatures.has(d);
    const originalColor = sel.attr('data-original-color') || '#000'; // Default to black if not set
    const isSig = sel.attr('data-is-significant') === 'true';

    if (isSelected) {
      sel.classed("neutralize-selected", true)
        .style('font-size', '12px')
        .style('font-weight', 'bold')
        .style('fill', '#d62728')
        .style('opacity', '1');
    } else {
      sel.classed("neutralize-selected", false)
        .style('font-size', '10px')
        .style('font-weight', isSig ? 'bold' : 'normal')
        .style('fill', originalColor)
        .style('opacity', '1');
    }
  });
}

/**
 * Make PCP axis titles clickable for neutralization feature selection
 * Call this after renderPCP() has drawn the axes
 *
 * NEW: Allows selecting MULTIPLE features to neutralize
 */
function makeAxisTitlesClickable() {
  d3.selectAll(".axis-title")
    .on("click", (event, d) => {
      event.stopPropagation();
      const sel = d3.select(event.target);
      const isSelected = sel.classed("neutralize-selected");

      if (isSelected) {
        // Second click: deselect
        window.neutralizationFeatures.delete(d);
      } else {
        // First click: select (can select multiple features)
        window.neutralizationFeatures.add(d);
      }

      updateNeutralizationDisplay();
      updatePcpAxisStyles();
    });
}

/**
 * Override getSelectedNeutralizeFeatures to read from the Set instead of checkboxes
 */
function getSelectedNeutralizeFeatures() {
  return Array.from(window.neutralizationFeatures || []);
}

// // Read the checked boxes for Apply
// function getSelectedNeutralizeFeatures() {
//   const sel = [];
//   d3.selectAll("#neutralize-feature-list input[type=checkbox]:checked")
//     .each(function() { sel.push(this.value); });
//   return sel;
// }

// Keep the scope label updated (Global / Streams / Groups / Outcomes)
function updateNeutralScopeLabel() {
  const sc = resolveNeutralScope();
  const map = { global: "Global (group composition)", streams: "Selected stream(s)", groups: "Selected group(s)", outcomes: "Selected outcome(s)" };
  d3.select("#neutral-scope-label").text(map[sc.type] || sc.type);
}

// One-time button wiring
function initNeutralizeUI() {
  d3.select("#btn-apply-neutral").on("click", applyNeutralization);
  d3.select("#btn-revert-neutral").on("click", () => {
    revertNeutralization();
    d3.select("#btn-revert-neutral").attr("disabled", true);
  });
  buildNeutralizeFeatureList();
  updateNeutralScopeLabel();
}


/* ========= FEATURE DISTRIBUTION VISUALIZATION ========= */

// Track which feature is currently being visualized
window.currentDistributionFeature = null;

/**
 * Get the data to visualize based on current selections
 * Returns { groups: [{ name, data: [...rows] }, ...], allData: [...rows] }
 */
/**
 * Get the data to visualize based on current selections
 * Returns { groups: [{ name, data: [...rows] }, ...], allData: [...rows] }
 */
function getDistributionData() {
  const all = state.data || [];

  // Check if stream selections are from distribution bars (feature-based) or confusion bars (outcome-based)
  const featureSelections = window.streamSelections ?
    Array.from(window.streamSelections.values()).filter(sel => sel.feature) : [];
  const outcomeSelections = window.streamSelections ?
    Array.from(window.streamSelections.values()).filter(sel => sel.outcome && !sel.feature) : [];

  const hasFeatureSelections = featureSelections.length > 0;
  const hasOutcomeSelections = outcomeSelections.length > 0;

  // Priority 1: Streams selected from confusion bars (outcome-based)
  // Show outcome groups even if feature selections exist (to maintain the grouped view)
  if (hasOutcomeSelections) {
    const streamIds = new Set();
    for (const sel of outcomeSelections) {
      sel.ids.forEach(id => streamIds.add(id));
    }
    const streamData = all.filter(r => streamIds.has(r.id ?? r._id));
    const groups = Array.from(window.streamSelections.entries())
      .filter(([k, sel]) => sel.outcome && !sel.feature)
      .map(([key, sel]) => ({
        name: `${sel.group} → ${sel.outcome}`,
        color: sel.color,
        data: streamData.filter(r => sel.ids.has(r.id ?? r._id))
      }));
    return { groups, allData: all };
  }

  // Priority 2: Outcomes selected
  if (selectedOutcomes && selectedOutcomes.size) {
    const groups = Array.from(selectedOutcomes).map(o => ({
      name: o,
      color: OUTCOME_COLORS[o] || "#999",
      data: all.filter(r => rowOutcome(r) === o)
    }));
    return { groups, allData: all };
  }

  // Default: Show distribution by protected groups (even if no explicit selection)
  // This uses the Sankey group names from the current protected attributes
  // This applies when feature-based selections are active OR no selections at all
  const groupNames = (window.LAST_GROUP_NAMES || []).slice();
  if (groupNames.length > 0) {
    const groups = groupNames.map(g => ({
      name: g,
      color: GROUP_COLOR_SCALE ? GROUP_COLOR_SCALE(g) : "#888",
      data: all.filter(r => rowMatchesGroup(r, g))
    })).filter(g => g.data.length > 0);
    return { groups, allData: all };
  }

  // Fallback: Show overall distribution
  return { groups: [], allData: all };
}

/**
 * Render the feature distribution comparison chart
 */
// Distribution panel mode: "feature" (counts) or "score" (avg score)
window.currentDistributionMode = window.currentDistributionMode || "feature";
function renderFeatureDistribution(feature) {
  const host = d3.select("#feature-distribution-chart");

  const numSet = new Set(state.numericKeys);
  const catSet = new Set(state.catKeys);

  // Guard: if no feature provided or feature doesn't exist
  if (!feature || (!numSet.has(feature) && !catSet.has(feature))) {
    host.selectAll("*").remove();
    host.append("div").attr("class", "muted")
      .style("padding", "20px")
      .text("Click on a PCP axis to view distribution");
    return;
  }

  host.selectAll("*").remove();
  window.currentDistributionFeature = feature;

  const isNumeric = numSet.has(feature);
  const { groups, allData } = getDistributionData();

  if (!allData.length) {
    host.append("div").attr("class", "muted")
      .style("padding", "20px")
      .text("No data available");
    return;
  }

  // Build per-group row sets (or a single “All Data” group)
  const chartGroups = groups.length ? groups : [{
    name: "All Data",
    color: "#888",
    data: allData
  }];

  // Check the feature actually has values in this slice
  const allVals = getFeatureValues(feature, allData, isNumeric).values;
  if (!allVals.length) {
    host.append("div").attr("class", "muted")
      .style("padding", "20px")
      .text(`No valid values for ${feature}`);
    return;
  }

  // Datasets for FEATURE mode (counts)
  const featureDatasets = chartGroups.map(g => {
    const vals = getFeatureValues(feature, g.data, isNumeric).values;
    return { name: g.name, color: g.color, values: vals };
  }).filter(d => d.values.length);

  if (!featureDatasets.length) {
    host.append("div").attr("class", "muted")
      .style("padding", "20px")
      .text(`No valid values for ${feature}`);
    return;
  }

  /* ───── Title ───── */
  const titleDiv = host.append("div")
    .style("font-size", "11px")
    .style("margin-bottom", "4px");

  titleDiv.append("span")
    .style("font-weight", "600")
    .text(`Distribution: ${feature}`);

  if (groups.length > 0) {
    titleDiv.append("span")
      .style("margin-left", "12px")
      .style("color", "#666")
      .style("font-size", "10px")
      .text(`(${groups.length} group${groups.length > 1 ? "s" : ""})`);
  }

  /* ───── Toggle buttons: Feature / Score ───── */
  // HIDDEN: Toggle buttons removed, always show score distribution
  const chartWrap = host.append("div")
    .attr("class", "distribution-chart-wrap");

  // Always render score distribution
  chartWrap.selectAll("*").remove();
  renderScoreByFeatureLevel(chartWrap, feature, chartGroups, isNumeric);
}
/**
 * Render grouped bar chart: x = feature levels / bins, y = average score.
 * Uses score_neutral if present, else score.
 * For numeric features, bins are built from all rows and shared across groups.
 */
function renderScoreByFeatureLevel(container, feature, chartGroups, isNumeric) {
  const allRows = chartGroups.flatMap(g => g.data || []);
  if (!allRows.length) {
    container.append("div").attr("class", "muted")
      .style("padding", "20px")
      .text("No data available");
    return;
  }

  const allValsObj = getFeatureValues(feature, allRows, isNumeric);
  const allVals = allValsObj.values;
  if (!allVals.length) {
    container.append("div").attr("class", "muted")
      .style("padding", "20px")
      .text(`No valid values for ${feature}`);
    return;
  }

  // ----- Build buckets: categories or numeric bins -----
  let buckets = [];

  if (!isNumeric) {
    // Categorical: one bucket per distinct category
    const cats = Array.from(new Set(allVals.map(v => String(v)))).sort();
    buckets = cats.map(cat => ({
      key: cat,
      label: cat,
      test: v => String(v) === cat
    }));
  } else {
    // Numeric: shared bins using d3.ticks over min / max
    const min = d3.min(allVals);
    const max = d3.max(allVals);
    const nTicks = Math.min(10, new Set(allVals).size);  // up to 10 bins
    const ticks = d3.ticks(min, max, nTicks);

    for (let i = 0; i < ticks.length - 1; i++) {
      const a = ticks[i];
      const b = ticks[i + 1];
      const label = i === ticks.length - 2
        ? `${d3.format(".2f")(a)}–${d3.format(".2f")(b)}`
        : `${d3.format(".2f")(a)}–${d3.format(".2f")(b)}`;
      buckets.push({
        key: `${a}-${b}`,
        label,
        test: v => {
          const x = +v;
          if (!Number.isFinite(x)) return false;
          if (i === ticks.length - 2) {
            return x >= a && x <= b;   // include max in last bin
          }
          return x >= a && x < b;
        }
      });
    }
  }

  if (!buckets.length) {
    container.append("div").attr("class", "muted")
      .style("padding", "20px")
      .text(`No valid values for ${feature}`);
    return;
  }

  // ----- Compute mean score per (group, bucket) -----
  const series = chartGroups.map(g => {
    const rows = g.data || [];
    const records = buckets.map(bucket => {
      const bucketRows = rows.filter(r => {
        const fv = r[feature];
        if (fv == null) return false;
        return bucket.test(isNumeric ? +fv : fv);
      });

      if (!bucketRows.length) {
        return { bucket, meanScore: NaN };
      }

      const scores = bucketRows
        .map(r => (r.score_neutral !== undefined ? r.score_neutral : r.score))
        .filter(v => v != null)
        .map(Number)
        .filter(Number.isFinite);

      if (!scores.length) {
        return { bucket, meanScore: NaN };
      }

      return { bucket, meanScore: d3.mean(scores) };
    });

    return { group: g.name, color: g.color, records };
  });

  // Flatten to find global max
  const allMeans = series.flatMap(s => s.records.map(r => r.meanScore))
    .filter(m => Number.isFinite(m));
  if (!allMeans.length) {
    container.append("div").attr("class", "muted")
      .style("padding", "20px")
      .text("No score data available for selected groups");
    return;
  }

  const maxMean = d3.max(allMeans);

  // ----- Draw grouped bar chart -----
  const margin = { top: 20, right: 10, bottom: 70, left: 40 };
  const width  = 350;  // you can adjust or derive from container.node().clientWidth
  const height = 210;

  const svg = container.append("svg")
    .attr("width", width)
    .attr("height", height);

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const innerW = width  - margin.left - margin.right;
  const innerH = height - margin.top  - margin.bottom;

  const bucketLabels = buckets.map(b => b.label);
  const groupNames   = chartGroups.map(g => g.name);

  const x0 = d3.scaleBand()
    .domain(bucketLabels)
    .range([0, innerW])
    .paddingInner(0.2);

  const x1 = d3.scaleBand()
    .domain(groupNames)
    .range([0, x0.bandwidth()])
    .padding(0.05);

  const y = d3.scaleLinear()
    .domain([0, maxMean])
    .nice()
    .range([innerH, 0]);

  // Axes
  const xAxis = d3.axisBottom(x0)
    .tickSizeOuter(0);

  const yAxis = d3.axisLeft(y)
    .ticks(5);

  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(xAxis)
    .selectAll("text")
    .style("font-size", "10px")
    .attr("text-anchor", "end")
    .attr("transform", "rotate(-35)");

  g.append("g")
    .call(yAxis)
    .selectAll("text")
    .style("font-size", "10px");

  g.append("text")
    .attr("x", innerW / 2)
    .attr("y", innerH + margin.bottom - 35)
    .attr("text-anchor", "middle")
    .style("font-size", "11px")
    .text(feature);

  g.append("text")
    .attr("transform", "rotate(-90)")
    .attr("x", -innerH / 2)
    .attr("y", -margin.left + 12)
    .attr("text-anchor", "middle")
    .style("font-size", "11px")
    .text("Average score");

  // Bars
  const bucketGroup = g.selectAll(".bucket-group")
    .data(buckets)
    .join("g")
    .attr("class", "bucket-group")
    .attr("transform", d => `translate(${x0(d.label)},0)`);

  // Create tooltip for distribution bars
  const distTooltip = createStyledTooltip("distribution-bar-tooltip");

  bucketGroup.selectAll("rect")
    .data(bucket => series.map(s => {
      const rec = s.records.find(r => r.bucket.key === bucket.key);
      return {
        group: s.group,
        color: s.color,
        bucket,
        meanScore: rec ? rec.meanScore : NaN,
        feature  // Pass feature name for filtering
      };
    }))
    .join("rect")
      .attr("x", d => x1(d.group))
      .attr("y", d => Number.isFinite(d.meanScore) ? y(d.meanScore) : y(0))
      .attr("width", x1.bandwidth())
      .attr("height", d => Number.isFinite(d.meanScore) ? (innerH - y(d.meanScore)) : 0)
      .attr("fill", d => d.color)
      .attr("opacity", d => {
        // Check if this bar is selected
        const key = `${d.group}|${d.feature}:${d.bucket.label}`;
        return (window.streamSelections && window.streamSelections.has(key)) ? 1 : 0.8;
      })
      .attr("stroke", d => {
        // Highlight selected bars with thicker border
        const key = `${d.group}|${d.feature}:${d.bucket.label}`;
        return (window.streamSelections && window.streamSelections.has(key)) ? "#000" : "#333";
      })
      .attr("stroke-width", d => {
        const key = `${d.group}|${d.feature}:${d.bucket.label}`;
        return (window.streamSelections && window.streamSelections.has(key)) ? 2.5 : 0.5;
      })
      .style("cursor", "pointer")
      .on("mouseover", function(event, d) {
        if (!Number.isFinite(d.meanScore)) return;
        const key = `${d.group}|${d.feature}:${d.bucket.label}`;
        const isSelected = window.streamSelections && window.streamSelections.has(key);
        if (!isSelected) {
          d3.select(this).attr("opacity", 1).attr("stroke-width", 2);
        }
        const html = `<div style="font-weight: bold; margin-bottom: 4px;">${d.group}</div>` +
                     `<div>${feature}: ${d.bucket.label}</div>` +
                     `<div>Avg Score: ${d.meanScore.toFixed(3)}</div>` +
                     `<div style="margin-top: 4px; font-size: 10px; font-style: italic;">Click to filter PCP</div>`;
        showStyledTooltip(distTooltip, html, event);
      })
      .on("mouseout", function(event, d) {
        const key = `${d.group}|${d.feature}:${d.bucket.label}`;
        const isSelected = window.streamSelections && window.streamSelections.has(key);
        if (!isSelected) {
          d3.select(this).attr("opacity", 0.8).attr("stroke-width", 0.5);
        }
        hideStyledTooltip(distTooltip);
      })
      .on("click", function(event, d) {
        handleDistributionBarClick(event, d);
      });

  // Simple legend at top-right
  // Simple legend at top-right, items side by side
  const legend = svg.append("g")
    .attr("transform", `translate(${width - margin.right - 200},${margin.top - 16})`);

  const LEGEND_ITEM_WIDTH = 70;  // space per item; tweak if names are longer

  chartGroups.forEach((g0, i) => {
    const item = legend.append("g")
      .attr("transform", `translate(${i * LEGEND_ITEM_WIDTH},0)`);

    item.append("rect")
      .attr("width", 10)
      .attr("height", 10)
      .attr("fill", g0.color);

    item.append("text")
      .attr("x", 14)
      .attr("y", 9)
      .style("font-size", "10px")
      .text(g0.name);
  });

}

/**
 * Extract and discretize values for a feature
 * Returns { values, isNumeric, label }
 */
function getFeatureValues(feature, data, isNumeric) {
  const vals = data.map(r => r[feature]).filter(v => v != null);
  
  if (isNumeric) {
    const nums = vals.map(Number).filter(Number.isFinite);
    return { values: nums, isNumeric: true, label: feature };
  }
  
  return { values: vals.map(String), isNumeric: false, label: feature };
}

/**
 * Create histogram bins for numeric data
 */
function createHistogramBins(data, numBins = 15) {
  if (!data.length) return [];
  
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const binWidth = range / numBins;
  
  const bins = Array(numBins).fill(null).map((_, i) => ({
    x0: min + i * binWidth,
    x1: min + (i + 1) * binWidth,
    count: 0
  }));
  
  for (const val of data) {
    let binIdx = Math.floor((val - min) / binWidth);
    binIdx = Math.max(0, Math.min(numBins - 1, binIdx));
    bins[binIdx].count++;
  }
  
  return bins;
}



// Add this helper function at the top of your distribution section:

// Add this helper function at the top of your distribution section:

function sanitizeClassName(str) {
  return String(str).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Then update renderNumericDistribution to use it:

function renderNumericDistribution(host, feature, chartData) {
  const M = { t: 10, r: 15, b: 70, l: 45 };
  const W = Math.min(350, host.node()?.clientWidth - 20 || 350);
  const H = 220;
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;
  
  const allValues = [];
  chartData.forEach(d => allValues.push(...d.values));
  const bins = createHistogramBins(allValues, 12);
  
  // NEW: Compute percentages within each group instead of raw counts
  const binData = bins.map(bin => {
    const row = { x0: bin.x0, x1: bin.x1 };
    chartData.forEach(dataset => {
      const count = dataset.values.filter(v => v >= bin.x0 && v < bin.x1).length;
      const total = dataset.values.length || 1;
      row[dataset.name] = (count / total) * 100; // Percentage
    });
    return row;
  });

  const svg = host.append("svg")
    .attr("width", W).attr("height", H)
    .style("display", "block")
    .style("border", "1px solid #eee");

  const g = svg.append("g").attr("transform", `translate(${M.l},${M.t})`);

  // NEW: Scale to actual max percentage in data (not always 100%)
  const maxPercent = Math.max(...binData.map(d =>
    Math.max(...chartData.map(ds => d[ds.name] || 0))
  )) || 1;

  const x = d3.scaleLinear()
    .domain([bins[0].x0, bins[bins.length - 1].x1])
    .range([0, innerW]);

  const y = d3.scaleLinear()
    .domain([0, maxPercent * 1.05]) // Add 5% padding at top
    .range([innerH, 0]);

  // Create styled tooltip
  const tooltip = createStyledTooltip(`numeric-dist-tooltip-${sanitizeClassName(feature)}`);

  // Draw bars - use index-based class names to avoid collisions
  chartData.forEach((dataset, dataIdx) => {
    const barWidth = innerW / bins.length * 0.8;
    const offset = (barWidth / chartData.length) * dataIdx - (barWidth / 2);
    const className = `dataset_${dataIdx}`;

    g.selectAll(`rect.${className}`)
      .data(binData)
      .join("rect")
        .attr("class", className)
        .attr("x", d => x(d.x0) + offset)
        .attr("y", d => y(d[dataset.name] || 0))
        .attr("width", barWidth / chartData.length)
        .attr("height", d => innerH - y(d[dataset.name] || 0))
        .attr("fill", dataset.color)
        .attr("fill-opacity", 1)
        .attr("stroke", dataset.color)
        .attr("stroke-width", 0.5)
        .on("mouseover", function(event, d) {
          const html = `<div style="font-weight: bold; margin-bottom: 4px;">${dataset.name}</div>` +
                       `<div>Range: [${d.x0.toFixed(2)}, ${d.x1.toFixed(2)})</div>` +
                       `<div>Percentage: ${(d[dataset.name] || 0).toFixed(1)}%</div>`;
          showStyledTooltip(tooltip, html, event);
        })
        .on("mousemove", function(event) {
          tooltip
            .style("left", (event.pageX + 10) + "px")
            .style("top", (event.pageY - 10) + "px");
        })
        .on("mouseout", function() {
          hideStyledTooltip(tooltip);
        });
  });

  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x).ticks(5))
    .selectAll("text").style("font-size", "9px");

  g.append("g")
    .call(d3.axisLeft(y).ticks(4).tickFormat(d => d + "%"))
    .selectAll("text").style("font-size", "9px");

  g.append("text")
    .attr("x", innerW / 2).attr("y", innerH + 40)
    .attr("text-anchor", "middle").style("font-size", "10px")
    .text(feature);

  g.append("text")
    .attr("x", -innerH / 2).attr("y", -35)
    .attr("text-anchor", "middle").attr("transform", "rotate(-90)")
    .style("font-size", "10px").text("Percentage");
  
  if (chartData.length > 1) {
    const legend = svg.append("g")
      .attr("transform", `translate(${M.l},${M.t - 8})`);
    
    chartData.forEach((d, i) => {
      const x = i * 120;
      legend.append("rect")
        .attr("x", x).attr("y", 0).attr("width", 8).attr("height", 8)
        .attr("fill", d.color).attr("fill-opacity", 0.6);
      legend.append("text")
        .attr("x", x + 12).attr("y", 7).style("font-size", "9px")
        .text(d.name.substring(0, 12));
    });
  }
}

// And update renderCategoricalDistribution similarly:

function renderCategoricalDistribution(host, feature, chartData) {
  const M = { t: 10, r: 15, b: 75, l: 45 };
  const W = Math.min(350, host.node()?.clientWidth - 20 || 350);
  const H = 220;
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;
  
  const allCats = new Set();
  chartData.forEach(d => d.values.forEach(v => allCats.add(String(v))));
  const categories = Array.from(allCats).sort();
  const displayCats = categories.slice(0, 10);
  
  // NEW: Compute percentages within each group instead of raw counts
  const freqData = displayCats.map(cat => {
    const row = { category: cat };
    chartData.forEach(dataset => {
      const count = dataset.values.filter(v => String(v) === cat).length;
      const total = dataset.values.length || 1;
      row[dataset.name] = (count / total) * 100; // Percentage
    });
    return row;
  });

  const svg = host.append("svg")
    .attr("width", W).attr("height", H)
    .style("display", "block")
    .style("border", "1px solid #eee");

  const g = svg.append("g").attr("transform", `translate(${M.l},${M.t})`);

  // NEW: Scale to actual max percentage in data (not always 100%)
  const maxPercent = Math.max(...freqData.map(d =>
    Math.max(...chartData.map(ds => d[ds.name] || 0))
  )) || 1;

  const x = d3.scaleBand()
    .domain(displayCats)
    .range([0, innerW])
    .padding(0.3);

  const x1 = d3.scaleBand()
    .domain(chartData.map(d => d.name))
    .range([0, x.bandwidth()])
    .padding(0.1);

  const y = d3.scaleLinear()
    .domain([0, maxPercent * 1.05]) // Add 5% padding at top
    .range([innerH, 0]);

  // Create styled tooltip
  const tooltip = createStyledTooltip(`categorical-dist-tooltip-${sanitizeClassName(feature)}`);

  // Draw grouped bars - use index-based class names to avoid collisions
  chartData.forEach((dataset, dataIdx) => {
    const className = `dataset_${dataIdx}`;

    g.selectAll(`rect.${className}`)
      .data(freqData)
      .join("rect")
        .attr("class", className)
        .attr("x", d => x(d.category) + x1(dataset.name))
        .attr("y", d => y(d[dataset.name] || 0))
        .attr("width", x1.bandwidth())
        .attr("height", d => innerH - y(d[dataset.name] || 0))
        .attr("fill", dataset.color)
        .attr("fill-opacity", 1)
        .attr("stroke", dataset.color)
        .attr("stroke-width", 0.5)
        .on("mouseover", function(event, d) {
          const html = `<div style="font-weight: bold; margin-bottom: 4px;">${dataset.name}</div>` +
                       `<div>Category: ${d.category}</div>` +
                       `<div>Percentage: ${(d[dataset.name] || 0).toFixed(1)}%</div>`;
          showStyledTooltip(tooltip, html, event);
        })
        .on("mousemove", function(event) {
          tooltip
            .style("left", (event.pageX + 10) + "px")
            .style("top", (event.pageY - 10) + "px");
        })
        .on("mouseout", function() {
          hideStyledTooltip(tooltip);
        });
  });

  g.append("g")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(x))
    .selectAll("text")
      .style("font-size", "9px")
      .style("text-anchor", "end")
      .attr("dx", "-0.4em")
      .attr("dy", "0.35em")
      .attr("transform", "rotate(-25)");

  g.append("g")
    .call(d3.axisLeft(y).ticks(4).tickFormat(d => d + "%"))
    .selectAll("text").style("font-size", "9px");

  g.append("text")
    .attr("x", innerW / 2).attr("y", innerH + 45)
    .attr("text-anchor", "middle").style("font-size", "10px")
    .text(feature);

  g.append("text")
    .attr("x", -innerH / 2).attr("y", -35)
    .attr("text-anchor", "middle").attr("transform", "rotate(-90)")
    .style("font-size", "10px").text("Percentage");
  
  if (chartData.length > 1) {
    const legend = svg.append("g")
      .attr("transform", `translate(${M.l},${M.t - 8})`);
    
    chartData.forEach((d, i) => {
      const x = i * 120;
      legend.append("rect")
        .attr("x", x).attr("y", 0).attr("width", 8).attr("height", 8)
        .attr("fill", d.color).attr("fill-opacity", 0.7);
      legend.append("text")
        .attr("x", x + 12).attr("y", 7).style("font-size", "10px")
        .text(d.name.substring(0, 12));
    });
  }
}









/**
 * Update distribution when selections change
 */
function updateFeatureDistribution() {
  if (window.currentDistributionFeature) {
    renderFeatureDistribution(window.currentDistributionFeature);
  }
}

/**
 * Hook into PCP axis click to show distribution
 * REPLACES makeAxisTitlesClickable() - wrap it to also trigger distribution
 */
function makeAxisTitlesClickableWithDistribution() {
  d3.selectAll(".axis-title")
    .style("cursor", "pointer")
    .on("click", (event, d) => {
      event.stopPropagation();
      
      // Priority: Show distribution for this feature
      // (This happens first so axis styling doesn't interfere)
      renderFeatureDistribution(d);
      
      // THEN toggle neutralization selection
      const sel = d3.select(event.target);
      const isSelected = sel.classed("neutralize-selected");
      const originalColor = sel.attr('data-original-color');
      const isSig = sel.attr('data-is-significant') === 'true';
      
      if (isSelected) {
        // Deselect
        window.neutralizationFeatures.delete(d);
        sel.classed("neutralize-selected", false)
          .style('font-size', '10px')
          .style('font-weight', isSig ? 'bold' : 'normal')
          .style('fill', originalColor);
      } else {
        // Select
        window.neutralizationFeatures.add(d);
        sel.classed("neutralize-selected", true)
          .style('font-size', '12px')
          .style('font-weight', 'bold')
          .style('fill', '#d62728');
      }
      
      updateNeutralizationDisplay();
      // NOTE: Don't call updatePcpAxisStyles() here - it will re-render all axes
      // and cause flickering. The styles are already set above.
    });
}

