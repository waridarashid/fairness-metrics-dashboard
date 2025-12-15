(function () {
  function _lab(c) {
    const L = d3.lab(c);
    return [L.l, L.a, L.b];
  }
  function _labDist(c1, c2) {
    const [L1, a1, b1] = _lab(c1), [L2, a2, b2] = _lab(c2);
    const dL = L1 - L2, da = a1 - a2, db = b1 - b2;
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  function _candidateColors() {
    // More hue steps for better coverage
    const hues = d3.range(0, 360, 10);
    
    // Multiple lightness and chroma rings for variety
    const rings = [
      { L: 55, C: 65 },  // Rich, saturated colors
      { L: 65, C: 55 },  // Medium vibrant
      { L: 75, C: 45 },  // Lighter, softer
      { L: 50, C: 50 }   // Darker, muted
    ];
    
    const out = [];
    for (const r of rings) {
      for (const h of hues) {
        out.push(d3.hcl(h, r.C, r.L).formatHex());
      }
    }
    
    // Filter out near-grays and very dark/light colors
    return out.filter(c => {
      const lab = d3.lab(c);
      const chromaAB = Math.hypot(lab.a, lab.b);
      // Keep colors with sufficient chroma and reasonable lightness
      return chromaAB > 25 && lab.l > 40 && lab.l < 85;
    });
  }

  // function genContrastingPalette(n) {
  //   const cand = _candidateColors();
  //   if (n <= 0) return [];
    
  //   // Better seed anchors - spread across color wheel with good saturation
  //   const anchors = [
  //     d3.hcl(15, 60, 60).formatHex(),   // Red-orange
  //     d3.hcl(140, 55, 62).formatHex(),  // Green
  //     d3.hcl(250, 58, 60).formatHex(),  // Blue-purple
  //     d3.hcl(45, 62, 68).formatHex(),   // Yellow-orange
  //     d3.hcl(190, 50, 58).formatHex(),  // Cyan
  //     d3.hcl(320, 55, 60).formatHex()   // Magenta
  //   ];
    
  //   const chosen = anchors.slice(0, Math.min(n, anchors.length));

  //   // Prune colors too similar to anchors
  //   const THRESH_INIT = 20;
  //   let pool = cand.filter(c => chosen.every(cc => _labDist(c, cc) > THRESH_INIT));

  //   // Greedy max-min selection
  //   while (chosen.length < n && pool.length) {
  //     let best = null, bestScore = -1;
  //     for (const c of pool) {
  //       const score = d3.min(chosen.map(cc => _labDist(c, cc)));
  //       if (score > bestScore) { 
  //         bestScore = score; 
  //         best = c; 
  //       }
  //     }
  //     if (best) {
  //       chosen.push(best);
  //       // Keep more candidates in pool for variety
  //       pool = pool.filter(c => _labDist(c, best) > 15);
  //     } else {
  //       break;
  //     }
  //   }

  //   // Fallback with better golden-angle dispersion
  //   while (chosen.length < n) {
  //     const i = chosen.length;
  //     const h = (i * 137.508) % 360;
  //     const L = 60 + ((i % 3) - 1) * 10;  // Vary lightness
  //     const C = 55 + ((i % 2)) * 8;        // Vary chroma
  //     chosen.push(d3.hcl(h, C, L).formatHex());
  //   }

  //   return chosen.slice(0, n);
  // }
function genContrastingPalette(n) {
  if (n <= 0) return [];
  if (n === 1) return [d3.hcl(30, 60, 60).formatHex()];  // Single color: orange
  
  const colors = [];
  
  // Use uniform hue spacing (covers full color wheel evenly)
  // This ensures we hit all major hues for small n
  const hueStep = 360 / n;
  
  for (let i = 0; i < n; i++) {
    // Start at 15° (red-orange) and space evenly around the wheel
    const h = (15 + i * hueStep) % 360;
    
    // Vary lightness to add dimension
    const L = 60 + ((i % 3) - 1) * 8;
    
    // Vary chroma for more vibrancy
    const C = 60 + ((i % 2)) * 5;
    
    colors.push(d3.hcl(h, C, L).formatHex());
  }
  
  return colors;
}

  // Export globally
  window.genContrastingPalette = genContrastingPalette;
})();