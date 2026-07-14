/* ============================================================
   mindmaps — hand-drawn SVG helpers
   Used by the app to draw connectors, and by book.html to
   render connector specimens. No dependencies.
   ============================================================ */

const MMSketch = (() => {
  // deterministic per-path randomness so lines don't dance on redraw
  function rng(seed) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => (s = (s * 16807) % 2147483647) / 2147483647 - 0.5;
  }

  // sample a cubic bezier, jitter interior points, emit a smoothed path
  function roughPath(x1, y1, cx1, cy1, cx2, cy2, x2, y2, jitter = 2.2, seed = 7) {
    const rnd = rng(seed);
    const pts = [];
    const N = 9;
    for (let i = 0; i <= N; i++) {
      const t = i / N, u = 1 - t;
      let x = u * u * u * x1 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * x2;
      let y = u * u * u * y1 + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t * t * t * y2;
      if (i > 0 && i < N) { x += rnd() * jitter * 2; y += rnd() * jitter * 2; }
      pts.push([x, y]);
    }
    let d = `M ${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += ` Q ${pts[i][0]} ${pts[i][1]}, ${mx} ${my}`;
    }
    const last = pts[pts.length - 1];
    d += ` L ${last[0]} ${last[1]}`;
    return d;
  }

  // draw a parent→child connector into an svg element.
  // opts: { ghost, echo = !ghost, hot, seed, jitter, axis: 'h' | 'v' }
  // axis 'h' curves sideways (default), 'v' curves downward — pick by
  // which delta dominates between the two anchor points.
  function connect(svg, x1, y1, x2, y2, opts = {}) {
    const NS = 'http://www.w3.org/2000/svg';
    const seed = opts.seed ?? Math.abs(Math.round(x1 * 13 + y1 * 7 + x2 * 3 + y2)) + 1;
    const axis = opts.axis ?? 'h';
    let c1x, c1y, c2x, c2y, ox, oy; // controls + echo offset
    if (axis === 'v') {
      const dir = y2 >= y1 ? 1 : -1;
      const k = Math.max(34, Math.abs(y2 - y1) * 0.5) * dir;
      c1x = x1; c1y = y1 + k; c2x = x2; c2y = y2 - k;
      ox = 2; oy = 1;
    } else {
      const dir = x2 >= x1 ? 1 : -1;
      const k = Math.max(34, Math.abs(x2 - x1) * 0.5) * dir;
      c1x = x1 + k; c1y = y1; c2x = x2 - k; c2y = y2;
      ox = 1.5; oy = 2;
    }
    const els = [];

    const main = document.createElementNS(NS, 'path');
    main.setAttribute('d', roughPath(x1, y1, c1x, c1y, c2x, c2y, x2, y2, opts.jitter ?? 2.2, seed));
    main.classList.add('mm-link');
    if (opts.ghost) main.classList.add('mm-link--ghost');
    if (opts.hot) main.classList.add('is-hot');
    svg.appendChild(main);
    els.push(main);

    const wantEcho = opts.echo ?? !opts.ghost;
    if (wantEcho) {
      // offset "pencil echo" stroke for the rough feel
      const echo = document.createElementNS(NS, 'path');
      echo.setAttribute('d', roughPath(x1 + ox, y1 + oy, c1x + ox, c1y + oy, c2x + ox, c2y + oy, x2 + ox, y2 + oy, 2.6, seed + 1));
      echo.classList.add('mm-link', 'mm-link--echo');
      svg.appendChild(echo);
      els.push(echo);
    }
    return els;
  }

  return { rng, roughPath, connect };
})();
