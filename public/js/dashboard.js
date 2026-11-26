// Observatorio Analítico Community 360
// Cumple Vercel Web Interface Guidelines (Intl.*, URL state sync, botones semánticos, a11y) + Chart.js 4

const CHART_PALETTE = [
  '#c9462c', // Bermellón señal
  '#184e48', // Ciprés profundo
  '#b97d18', // Ocre dorado
  '#6d3b53', // Ciruela pizarra
  '#246e55', // Salvia bosque
  '#de7456', // Terracota suave
  '#48756e', // Pino mineral
  '#94603e', // Cobre tierra
  '#a65d75', // Malva seco
  '#646b58', // Piedra oliva
];

const COUNTRY_ISO = {
  México: 'MX',
  'Estados Unidos': 'US',
  Colombia: 'CO',
  Argentina: 'AR',
  Perú: 'PE',
  Chile: 'CL',
  España: 'ES',
};

const VIEW_SLUGS = {
  pulso: 'vista-pulso',
  flujo: 'vista-flujo',
  comunidad: 'vista-comunidad',
  regiones: 'vista-regiones',
};

const SLUG_BY_VIEW = {
  'vista-pulso': 'pulso',
  'vista-flujo': 'flujo',
  'vista-comunidad': 'comunidad',
  'vista-regiones': 'regiones',
};

const numberFmt = new Intl.NumberFormat('es-MX');
const timeFmt = new Intl.DateTimeFormat('es-MX', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

// Plugin de Chart.js 4 para dibujar el indicador centrado dentro de los anillos de dona
const centerLabelPlugin = {
  id: 'centerLabel',
  afterDraw(chart) {
    const cfg = chart.options?.plugins?.centerLabel;
    if (!cfg || !cfg.value) return;

    const { ctx, chartArea } = chart;
    if (!chartArea) return;

    const centerX = (chartArea.left + chartArea.right) / 2;
    const centerY = (chartArea.top + chartArea.bottom) / 2;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = '700 1.45rem "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = cfg.valueColor || '#12211f';
    ctx.fillText(String(cfg.value), centerX, centerY - 7);

    ctx.font = '600 0.72rem "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = cfg.subColor || '#5f706d';
    ctx.fillText(String(cfg.subtitle || ''), centerX, centerY + 14);
    ctx.restore();
  },
};

if (typeof Chart !== 'undefined') {
  Chart.register(centerLabelPlugin);
}

const charts = {};
const currentNumericValues = {};
let latestLiveMetrics = null;
let latestHistStats = null;
let selectedCountry = 'ALL';
let activeView = 'vista-pulso';
let unreadStreamEvents = 0;

function syncUrlState() {
  const url = new URL(window.location.href);
  url.searchParams.set('vista', SLUG_BY_VIEW[activeView] || 'pulso');
  if (selectedCountry && selectedCountry !== 'ALL') {
    url.searchParams.set('pais', selectedCountry);
  } else {
    url.searchParams.delete('pais');
  }
  window.history.replaceState(null, '', url.toString());
}

function readInitialUrlState() {
  const params = new URLSearchParams(window.location.search);
  const vistaParam = params.get('vista');
  const paisParam = params.get('pais');
  if (vistaParam && VIEW_SLUGS[vistaParam]) {
    activeView = VIEW_SLUGS[vistaParam];
  }
  if (paisParam) {
    selectedCountry = paisParam;
  }
}

// Animación suave de conteo numérico (count-up / interpolación sin lecturas de layout)
function animateNumber(id, targetValue, decimals = 0) {
  const el = document.getElementById(id);
  if (!el) return;

  const end = Number(targetValue) || 0;
  const start = id in currentNumericValues ? currentNumericValues[id] : 0;
  currentNumericValues[id] = end;

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = decimals > 0 ? end.toFixed(decimals) : numberFmt.format(Math.round(end));
    return;
  }

  const duration = 620;
  const startTime = performance.now();

  function tick(now) {
    const progress = Math.min((now - startTime) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 4);
    const val = start + (end - start) * eased;

    el.textContent = decimals > 0
      ? val.toFixed(decimals)
      : numberFmt.format(Math.round(val));

    if (progress < 1) {
      requestAnimationFrame(tick);
    }
  }

  requestAnimationFrame(tick);
}

function isDarkMode() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

function getThemeChartTokens() {
  const dark = isDarkMode();
  return {
    mainText: dark ? '#f1f4f2' : '#12211f',
    tickColor: dark ? '#92a19d' : '#5f706d',
    legendColor: dark ? '#cad3cf' : '#354744',
    gridColor: dark ? 'rgba(202, 211, 207, 0.08)' : 'rgba(18, 33, 31, 0.06)',
    borderSurface: dark ? '#151f1e' : '#ffffff',
    tooltipBg: dark ? '#0e1514' : '#12211f',
    ember: dark ? '#e25f45' : '#c9462c',
    emberHover: dark ? '#ec735b' : '#ad3922',
    botanical: dark ? '#49a599' : '#184e48',
    botanicalHover: dark ? '#60b8ac' : '#123e39',
    plum: dark ? '#b56d8f' : '#6d3b53',
    ochre: dark ? '#dfa43c' : '#b97d18',
    sage: dark ? '#44a884' : '#246e55',
    clay: dark ? '#df6262' : '#b53636',
    stone: dark ? '#6e7c78' : '#9aa6a2',
  };
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatLabel(raw) {
  if (!raw) return '';
  const map = {
    mensaje: 'Mensaje',
    comentario: 'Comentario',
    reaccion: 'Reacción',
    respuesta_encuesta: 'Encuesta',
    rsvp_evento: 'RSVP Evento',
    activo: 'Activo',
    en_riesgo: 'En riesgo',
    inactivo: 'Inactivo',
    Fursuit: 'Diseño de Vestuario',
  };
  return map[raw] || raw;
}

function switchView(targetId, updateHistory = true) {
  activeView = targetId;
  document.querySelectorAll('.nav-tab-btn').forEach((btn) => {
    const isCurrent = btn.dataset.view === targetId;
    btn.classList.toggle('active', isCurrent);
    btn.setAttribute('aria-current', isCurrent ? 'page' : 'false');
  });
  document.querySelectorAll('.view-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === targetId);
  });

  if (targetId === 'vista-flujo') {
    unreadStreamEvents = 0;
    const badge = document.getElementById('badgeFlujo');
    if (badge) {
      badge.textContent = '0';
      badge.classList.remove('visible');
    }
  }

  if (updateHistory) {
    syncUrlState();
  }

  requestAnimationFrame(() => {
    Object.values(charts).forEach((chart) => {
      if (chart && typeof chart.resize === 'function') {
        chart.resize();
      }
    });
  });
}

async function apiGet(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getToken()}`,
    },
  });

  if (res.status === 401) {
    clearSession();
    window.location.replace('/login.html');
    throw new Error('Sesión expirada');
  }

  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.message || `Error HTTP ${res.status}`);
  }
  return json.data;
}

function showToast(title, detail, type = 'created') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<strong>${escapeHtml(title)}</strong><br><span style="color:var(--text-muted)">${escapeHtml(detail)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(18px)';
    toast.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
    setTimeout(() => toast.remove(), 280);
  }, 4600);
}

function pulseKpis() {
  document.querySelectorAll('.kpi-card.live-kpi').forEach((card) => {
    card.classList.add('pulse-update');
    setTimeout(() => card.classList.remove('pulse-update'), 1300);
  });
}

function createOrUpdateChart(id, config) {
  const canvas = document.getElementById(id);
  if (!canvas) return;

  if (charts[id]) {
    charts[id].data = config.data;
    charts[id].options = config.options;
    charts[id].update();
  } else {
    charts[id] = new Chart(canvas.getContext('2d'), config);
  }
}

function defaultChartOptions(horizontal = false) {
  const t = getThemeChartTokens();
  return {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: horizontal ? 'y' : 'x',
    animation: {
      duration: 750,
      easing: 'easeOutQuart',
    },
    plugins: {
      legend: {
        display: false,
        labels: { color: t.legendColor, font: { size: 12 } },
      },
      tooltip: {
        backgroundColor: t.tooltipBg,
        titleColor: '#f1f4f2',
        bodyColor: '#dce3df',
        borderColor: 'rgba(202, 211, 207, 0.20)',
        borderWidth: 1,
        padding: 11,
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        ticks: { color: t.tickColor, font: { size: 11, weight: '500' } },
        grid: { color: t.gridColor },
      },
      y: {
        ticks: { color: t.tickColor, font: { size: 11, weight: '500' } },
        grid: { color: t.gridColor },
        beginAtZero: true,
      },
    },
  };
}

function doughnutOptions(legendPosition = 'bottom', centerValue = '', centerSubtitle = '') {
  const t = getThemeChartTokens();
  return {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '68%',
    animation: {
      animateScale: true,
      animateRotate: true,
      duration: 800,
      easing: 'easeOutQuart',
    },
    plugins: {
      centerLabel: centerValue
        ? {
            value: centerValue,
            subtitle: centerSubtitle,
            valueColor: t.mainText,
            subColor: t.tickColor,
          }
        : false,
      legend: {
        position: legendPosition,
        labels: { color: t.legendColor, padding: 14, boxWidth: 12, font: { size: 11, weight: '500' } },
      },
      tooltip: {
        backgroundColor: t.tooltipBg,
        titleColor: '#f1f4f2',
        bodyColor: '#dce3df',
        borderColor: 'rgba(202, 211, 207, 0.20)',
        borderWidth: 1,
        padding: 11,
        cornerRadius: 8,
      },
    },
  };
}

function renderHeatmap(heatmap) {
  const container = document.getElementById('heatmapContainer');
  if (!container) return;

  const { canales = [], tipos = [], matriz = {} } = heatmap || {};
  if (canales.length === 0 || tipos.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);text-align:center;">Aún no hay interacciones suficientes para mostrar el mapa de actividad.</p>';
    return;
  }

  let maxVal = 1;
  const colTotals = {};
  tipos.forEach((t) => { colTotals[t] = 0; });

  canales.forEach((c) => {
    tipos.forEach((t) => {
      const val = matriz[c]?.[t] || 0;
      colTotals[t] += val;
      if (val > maxVal) maxVal = val;
    });
  });

  const dark = isDarkMode();
  const baseRgb = dark ? '73, 165, 153' : '24, 78, 72';

  let grandTotal = 0;
  let html = '<table class="heatmap-table"><thead><tr><th>Canal y formato</th>';
  tipos.forEach((t) => {
    html += `<th style="text-align:center">${escapeHtml(formatLabel(t))}</th>`;
  });
  html += '<th style="text-align:center">Total</th></tr></thead><tbody>';

  canales.forEach((c) => {
    let rowTotal = 0;
    html += `<tr><td><strong>${escapeHtml(c)}</strong></td>`;
    tipos.forEach((t) => {
      const val = matriz[c]?.[t] || 0;
      rowTotal += val;
      const ratio = val / maxVal;
      const alpha = val === 0 ? 0.05 : (0.14 + ratio * 0.78).toFixed(2);
      const textColor = ratio > 0.48 ? '#ffffff' : (dark ? '#f1f4f2' : '#12211f');
      html += `<td class="heatmap-cell" style="background:rgba(${baseRgb},${alpha});color:${textColor}">${numberFmt.format(val)}</td>`;
    });
    grandTotal += rowTotal;
    html += `<td class="heatmap-total">${numberFmt.format(rowTotal)}</td></tr>`;
  });

  html += '<tr><td><strong>Total por formato</strong></td>';
  tipos.forEach((t) => {
    html += `<td class="heatmap-total">${numberFmt.format(colTotals[t])}</td>`;
  });
  html += `<td class="heatmap-total">${numberFmt.format(grandTotal)}</td></tr>`;

  html += '</tbody></table>';
  container.innerHTML = html;
}

function renderRecentInteractions(items, highlightId = null) {
  const tbody = document.getElementById('recentInteractionsBody');
  if (!tbody) return;

  if (!items || items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">Aún no se han registrado interacciones recientes.</td></tr>';
    return;
  }

  tbody.innerHTML = items
    .map((item) => {
      const s = Number(item.sentimiento || 0);
      let badgeClass = 'sentiment-neu';
      let label = 'Neutro';
      if (s > 0.1) {
        badgeClass = 'sentiment-pos';
        label = 'Positivo';
      } else if (s < -0.1) {
        badgeClass = 'sentiment-neg';
        label = 'Negativo';
      }

      const ubic = item.ubicacion
        ? `${item.ubicacion.ciudad || ''}, ${item.ubicacion.pais || ''}`.replace(/^,\s*|,\s*$/g, '')
        : 'Ubicación reservada';

      const rowClass = highlightId && item.id_interaccion === highlightId ? 'row-highlight' : '';
      const textoCorto = item.texto
        ? escapeHtml(item.texto.length > 62 ? item.texto.slice(0, 62) + '…' : item.texto)
        : '<em style="color:var(--text-muted)">Reacción rápida sin texto</em>';

      const tagsHtml = Array.isArray(item.etiquetas) && item.etiquetas.length > 0
        ? '<div style="margin-top:0.28rem">' + item.etiquetas.map((t) => `<span class="tag-chip" translate="no">#${escapeHtml(t)}</span>`).join('') + '</div>'
        : '';

      return `
        <tr class="${rowClass}">
          <td><span class="mono-code" translate="no">${escapeHtml(item.id_interaccion)}</span></td>
          <td><span class="mono-code" translate="no">${escapeHtml(item.id_usuario)}</span></td>
          <td><span class="channel-pill" translate="no">${escapeHtml(item.canal)}</span></td>
          <td style="font-weight:500">${escapeHtml(formatLabel(item.tipo))}</td>
          <td><span class="sentiment-badge ${badgeClass}">${s.toFixed(2)} (${label})</span></td>
          <td style="font-variant-numeric:tabular-nums;font-weight:700">${numberFmt.format(Number(item.reacciones_recibidas ?? 0))}</td>
          <td><strong>${escapeHtml(ubic)}</strong><br><small style="color:var(--text-muted)">${textoCorto}</small>${tagsHtml}</td>
        </tr>
      `;
    })
    .join('');
}

function renderLiveMetrics(metrics, highlightId = null, isRealtimeUpdate = false) {
  latestLiveMetrics = metrics;
  const { kpis, distribuciones, heatmap, recientes, actualizado_en } = metrics;
  const t = getThemeChartTokens();

  animateNumber('kpiTotalInteracciones', kpis.total_interacciones, 0);
  animateNumber('kpiSentimientoPromedio', kpis.sentimiento_promedio, 3);
  animateNumber('kpiTasaInteraccion', kpis.tasa_interaccion_usuario, 3);
  animateNumber('kpiPromedioReacciones', kpis.promedio_reacciones, 2);
  animateNumber('kpiTotalUsuarios', kpis.total_usuarios, 0);

  const sentCaption = document.getElementById('kpiSentimientoCaption');
  if (sentCaption) {
    if (kpis.sentimiento_promedio > 0.1) {
      sentCaption.textContent = `${kpis.porcentaje_positivo}% favorable`;
    } else if (kpis.sentimiento_promedio < -0.1) {
      sentCaption.textContent = 'Tendencia negativa';
    } else {
      sentCaption.textContent = 'Balance neutro';
    }
  }

  const lastUpdateEl = document.getElementById('lastUpdateText');
  if (lastUpdateEl && actualizado_en) {
    lastUpdateEl.textContent = `Actualizado ${timeFmt.format(new Date(actualizado_en))}`;
  }

  if (isRealtimeUpdate) {
    pulseKpis();
    if (activeView !== 'vista-flujo') {
      unreadStreamEvents += 1;
      const badge = document.getElementById('badgeFlujo');
      if (badge) {
        badge.textContent = `+${unreadStreamEvents}`;
        badge.classList.add('visible');
      }
    }
  }

  // 1. Balance de Sentimiento (Dona con indicador central)
  const sent = distribuciones.sentimiento || { Positivo: 0, Neutro: 0, Negativo: 0 };
  createOrUpdateChart('chartSentimiento', {
    type: 'doughnut',
    data: {
      labels: ['Positivo', 'Neutro', 'Negativo'],
      datasets: [{
        data: [sent.Positivo || 0, sent.Neutro || 0, sent.Negativo || 0],
        backgroundColor: [t.sage, t.ochre, t.clay],
        borderColor: t.borderSurface,
        borderWidth: 3,
        hoverOffset: 6,
      }],
    },
    options: doughnutOptions('bottom', `${kpis.porcentaje_positivo}%`, 'Favorable'),
  });

  // 2. Volumen por Tipo de Actividad (Barras — Bermellón)
  const tiposEntries = Object.entries(distribuciones.tipo || {}).sort((a, b) => b[1] - a[1]);
  createOrUpdateChart('chartTipos', {
    type: 'bar',
    data: {
      labels: tiposEntries.map(([k]) => formatLabel(k)),
      datasets: [{
        label: 'Interacciones',
        data: tiposEntries.map(([, v]) => v),
        backgroundColor: t.ember,
        hoverBackgroundColor: t.emberHover,
        borderRadius: 7,
      }],
    },
    options: defaultChartOptions(false),
  });

  // 3. Participación por Canal Social (Barras — Ciprés)
  const canalesEntries = Object.entries(distribuciones.canal || {}).sort((a, b) => b[1] - a[1]);
  createOrUpdateChart('chartCanales', {
    type: 'bar',
    data: {
      labels: canalesEntries.map(([k]) => k),
      datasets: [{
        label: 'Interacciones',
        data: canalesEntries.map(([, v]) => v),
        backgroundColor: t.botanical,
        hoverBackgroundColor: t.botanicalHover,
        borderRadius: 7,
      }],
    },
    options: defaultChartOptions(false),
  });

  // 4. Mapa de Intensidad Multicanal y Flujo Reciente
  renderHeatmap(heatmap);
  renderRecentInteractions(recientes, highlightId);
}

function renderRegionalView(hist) {
  const t = getThemeChartTokens();
  const paises = Array.isArray(hist.por_pais) ? hist.por_pais : [];
  const ciudades = Array.isArray(hist.ciudades_detalle) && hist.ciudades_detalle.length > 0
    ? hist.ciudades_detalle
    : (hist.top_ciudades || []).map((c) => {
        const parts = String(c.etiqueta || '').split(',');
        return {
          ciudad: (parts[0] || '').trim(),
          estado: '',
          pais: (parts[1] || '').trim(),
          zona_horaria: '',
          etiqueta: c.etiqueta,
          total: c.total,
        };
      });

  if (selectedCountry !== 'ALL' && !paises.some((p) => p.etiqueta === selectedCountry)) {
    selectedCountry = 'ALL';
  }

  const totalConUbic = paises.reduce((acc, p) => acc + Number(p.total || 0), 0) || 1;
  const totalUsuarios = Number(hist.resumen?.total_usuarios || 0) || 1;
  const conConsent = Number(hist.resumen?.con_consentimiento || totalConUbic);

  animateNumber('kpiTotalPaises', paises.length, 0);
  animateNumber('kpiTotalCiudades', ciudades.length, 0);
  animateNumber('kpiConConsentimiento', conConsent, 0);

  const elConsentPct = document.getElementById('kpiConsentimientoPct');
  if (elConsentPct) {
    elConsentPct.textContent = `${((conConsent / totalUsuarios) * 100).toFixed(1)}% compartió ubicación`;
  }

  // 1. Explorador interactivo por país usando botones semánticos (<button type="button">)
  const explorer = document.getElementById('countriesExplorer');
  if (explorer) {
    explorer.innerHTML = paises
      .map((p) => {
        const pct = ((p.total / totalConUbic) * 100).toFixed(1);
        const iso = COUNTRY_ISO[p.etiqueta] || p.etiqueta.slice(0, 2).toUpperCase();
        const isSelected = selectedCountry === p.etiqueta;
        const sedesTxt = p.ciudades ? `${p.ciudades} ${p.ciudades === 1 ? 'ciudad activa' : 'ciudades activas'}` : 'Presencia verificada';

        return `
          <button type="button" class="country-item ${isSelected ? 'selected' : ''}" aria-pressed="${isSelected}" data-country="${escapeHtml(p.etiqueta)}">
            <div class="country-top">
              <div class="country-identity">
                <span class="country-iso" translate="no">${escapeHtml(iso)}</span>
                <div>
                  <div class="country-name">${escapeHtml(p.etiqueta)}</div>
                  <div class="country-sub">${escapeHtml(sedesTxt)}</div>
                </div>
              </div>
              <div class="country-stats">
                <div class="country-count">${numberFmt.format(Number(p.total))} miembros</div>
                <div class="country-share">${pct}% regional</div>
              </div>
            </div>
            <div class="country-bar-track" aria-hidden="true">
              <div class="country-bar-fill" style="width:${Math.max(Number(pct), 3)}%"></div>
            </div>
          </button>
        `;
      })
      .join('');

    explorer.querySelectorAll('.country-item').forEach((card) => {
      card.addEventListener('click', () => {
        const c = card.dataset.country;
        selectedCountry = selectedCountry === c ? 'ALL' : c;
        syncUrlState();
        renderRegionalView(hist);
      });
    });
  }

  // 2. Rosa Polar (Chart.js 4 polarArea) compacta y balanceada radialmente en 360°
  const top8 = ciudades.slice(0, 8);
  const polarColors = [
    '#c9462c',
    '#184e48',
    '#b97d18',
    '#6d3b53',
    '#246e55',
    '#de7456',
    '#48756e',
    '#94603e',
  ];
  const polarFills = [
    'rgba(201, 70, 44, 0.84)',
    'rgba(24, 78, 72, 0.84)',
    'rgba(185, 125, 24, 0.84)',
    'rgba(109, 59, 83, 0.84)',
    'rgba(36, 110, 85, 0.84)',
    'rgba(222, 116, 86, 0.84)',
    'rgba(72, 117, 110, 0.84)',
    'rgba(148, 96, 62, 0.84)',
  ];

  const radialOrder = [0, 4, 2, 6, 1, 5, 3, 7].filter((idx) => idx < top8.length);
  const orderedItems = radialOrder.map((idx) => ({
    city: top8[idx],
    fill: polarFills[idx % polarFills.length],
    realCount: Number(top8[idx].total || 0),
  }));

  createOrUpdateChart('chartPolarRegiones', {
    type: 'polarArea',
    data: {
      labels: orderedItems.map((item) => item.city.ciudad || item.city.etiqueta),
      datasets: [{
        data: orderedItems.map((item) => Number(Math.sqrt(Math.max(item.realCount, 1)).toFixed(3))),
        backgroundColor: orderedItems.map((item) => item.fill),
        borderColor: t.borderSurface,
        borderWidth: 2.5,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 1,
      layout: {
        padding: 6,
      },
      animation: {
        animateRotate: true,
        animateScale: true,
        duration: 800,
        easing: 'easeOutQuart',
      },
      scales: {
        r: {
          beginAtZero: true,
          ticks: { display: false },
          grid: { color: t.gridColor },
        },
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          backgroundColor: t.tooltipBg,
          titleColor: '#f1f4f2',
          bodyColor: '#dce3df',
          padding: 11,
          cornerRadius: 8,
          callbacks: {
            label(ctx) {
              const real = orderedItems[ctx.dataIndex]?.realCount ?? 0;
              return ` ${numberFmt.format(real)} miembros`;
            },
          },
        },
      },
    },
  });

  const polarLegend = document.getElementById('polarLegendGrid');
  if (polarLegend) {
    polarLegend.innerHTML = top8
      .map((c, i) => `
        <div class="polar-legend-item">
          <span class="polar-legend-left">
            <span class="polar-swatch" style="background:${polarColors[i % polarColors.length]}" aria-hidden="true"></span>
            <span class="polar-city-name">${escapeHtml(c.ciudad || c.etiqueta)}</span>
          </span>
          <span class="polar-city-val">${numberFmt.format(Number(c.total || 0))}</span>
        </div>
      `)
      .join('');
  }

  // 3. Píldoras centradas de filtro por país y tarjetas de ciudades
  const filterBar = document.getElementById('countryFilterBar');
  if (filterBar) {
    const pills = ['ALL', ...paises.map((p) => p.etiqueta)];
    filterBar.innerHTML = pills
      .map((code) => {
        const label = code === 'ALL' ? 'Todos los países' : code;
        const active = selectedCountry === code;
        return `<button type="button" class="filter-pill ${active ? 'active' : ''}" aria-pressed="${active}" data-filter="${escapeHtml(code)}">${escapeHtml(label)}</button>`;
      })
      .join('');

    filterBar.querySelectorAll('.filter-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedCountry = btn.dataset.filter;
        syncUrlState();
        renderRegionalView(hist);
      });
    });
  }

  const filteredCities = selectedCountry === 'ALL'
    ? ciudades
    : ciudades.filter((c) => c.pais === selectedCountry);

  const countBadge = document.getElementById('citiesCountBadge');
  if (countBadge) {
    countBadge.textContent = selectedCountry === 'ALL'
      ? `${filteredCities.length} sedes activas`
      : `${selectedCountry} (${filteredCities.length} sedes)`;
  }

  const grid = document.getElementById('citiesHubGrid');
  if (grid) {
    grid.innerHTML = filteredCities
      .map((c) => {
        const tz = c.zona_horaria ? c.zona_horaria.replace('America/', '').replace('Europe/', '').replace(/_/g, ' ') : c.pais;
        const sub = c.estado ? `${c.estado}, ${c.pais} (${tz})` : `${c.pais} (${tz})`;
        return `
          <div class="city-node-card">
            <div class="city-node-info">
              <strong>${escapeHtml(c.ciudad || c.etiqueta)}</strong>
              <small>${escapeHtml(sub)}</small>
            </div>
            <div class="city-node-badge">
              <strong>${numberFmt.format(Number(c.total))}</strong>
              <span>miembros</span>
            </div>
          </div>
        `;
      })
      .join('');
  }
}

function renderHistoricalStats(hist) {
  latestHistStats = hist;
  const t = getThemeChartTokens();
  const estatus = hist.usuarios_estatus || {
    activo: hist.activo ?? 0,
    en_riesgo: hist.en_riesgo ?? 0,
    inactivo: hist.inactivo ?? 0,
    porcentaje_en_riesgo: 0,
  };

  animateNumber('kpiUsuariosEnRiesgo', estatus.en_riesgo || 0, 0);
  animateNumber('kpiUsuariosActivos', estatus.activo || 0, 0);
  animateNumber('kpiUsuariosInactivos', estatus.inactivo || 0, 0);
  animateNumber('kpiTotalArtistas', hist.resumen?.total_artistas || 0, 0);

  const elPctRiesgo = document.getElementById('kpiPorcentajeRiesgo');
  if (elPctRiesgo) {
    elPctRiesgo.textContent = `${Number(estatus.porcentaje_en_riesgo || 0).toFixed(1)}% del padrón total`;
  }

  const totalMiembros = numberFmt.format(Number(hist.resumen?.total_usuarios || 0));

  // 1. Estado de Retención de Miembros (Dona con indicador central)
  createOrUpdateChart('chartEstatus', {
    type: 'doughnut',
    data: {
      labels: ['Activo', 'En riesgo', 'Inactivo'],
      datasets: [{
        data: [estatus.activo || 0, estatus.en_riesgo || 0, estatus.inactivo || 0],
        backgroundColor: [t.sage, t.ochre, t.stone],
        borderColor: t.borderSurface,
        borderWidth: 3,
        hoverOffset: 6,
      }],
    },
    options: doughnutOptions('bottom', totalMiembros, 'Miembros'),
  });

  // 2. Adopción por Plataforma Principal (Barras Horizontales)
  createOrUpdateChart('chartPlataformas', {
    type: 'bar',
    data: {
      labels: hist.por_plataforma.map((r) => r.etiqueta),
      datasets: [{
        label: 'Miembros',
        data: hist.por_plataforma.map((r) => r.total),
        backgroundColor: t.botanical,
        borderRadius: 7,
      }],
    },
    options: defaultChartOptions(true),
  });

  // 3. Estructura por Rango de Edad (Barras)
  createOrUpdateChart('chartEdades', {
    type: 'bar',
    data: {
      labels: hist.por_edad.map((r) => r.etiqueta),
      datasets: [{
        label: 'Miembros',
        data: hist.por_edad.map((r) => r.total),
        backgroundColor: t.plum,
        borderRadius: 7,
      }],
    },
    options: defaultChartOptions(false),
  });

  // 4. Áreas de Interés Cultural y Digital (Dona con indicador central)
  const interesesSource = Array.isArray(hist.por_interes) && hist.por_interes.length > 0
    ? hist.por_interes
    : (hist.por_especie || []);

  createOrUpdateChart('chartIntereses', {
    type: 'doughnut',
    data: {
      labels: interesesSource.map((r) => formatLabel(r.etiqueta)),
      datasets: [{
        data: interesesSource.map((r) => r.total),
        backgroundColor: CHART_PALETTE,
        borderColor: t.borderSurface,
        borderWidth: 3,
        hoverOffset: 6,
      }],
    },
    options: doughnutOptions('right', `${interesesSource.length}`, 'Áreas'),
  });

  // 5. Vista Internacional por Países, Rosa Polar y Directorio de Sedes
  renderRegionalView(hist);
}

async function initDashboard() {
  readInitialUrlState();

  const user = getUser();
  if (user && user.usuario) {
    document.getElementById('displayUsername').textContent = user.usuario;
    const avatar = document.getElementById('userAvatar');
    if (avatar) avatar.textContent = user.usuario.charAt(0).toUpperCase();
  }

  // Navegación entre módulos seccionados con sincronización en URL
  document.querySelectorAll('.nav-tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchView(btn.dataset.view, true);
    });
  });

  switchView(activeView, false);

  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('c360_theme', next);
      const meta = document.getElementById('metaThemeColor');
      if (meta) meta.setAttribute('content', next === 'dark' ? '#0e1514' : '#f6f6f2');
      if (latestLiveMetrics) renderLiveMetrics(latestLiveMetrics, null, false);
      if (latestHistStats) renderHistoricalStats(latestHistStats);
    });
  }

  try {
    const [liveData, histData] = await Promise.all([
      apiGet('/api/stats/live'),
      apiGet('/api/stats/historical'),
    ]);
    renderLiveMetrics(liveData, null, false);
    renderHistoricalStats(histData);
  } catch (err) {
    console.error('[Dashboard] Error al cargar datos iniciales:', err);
    showToast('Error de sincronización', err.message, 'deleted');
  }

  // Conexión WebSocket autenticada con JWT
  const socket = io({
    auth: { token: getToken() },
  });

  const socketDot = document.getElementById('socketDot');
  const socketStatus = document.getElementById('socketStatus');

  socket.on('connect', () => {
    socketDot.className = 'dot connected';
    socketStatus.textContent = 'En línea';
  });

  socket.on('connect_error', (err) => {
    socketDot.className = 'dot';
    socketStatus.textContent = `Sin conexión (${err.message})`;
  });

  socket.on('disconnect', () => {
    socketDot.className = 'dot';
    socketStatus.textContent = 'Reconectando…';
  });

  socket.on('interaction:created', (payload) => {
    if (payload?.metrics) {
      renderLiveMetrics(payload.metrics, payload.interaction?.id_interaccion, true);
    }
    showToast(
      'Nueva interacción registrada',
      `${payload.interaction?.id_interaccion} en ${payload.interaction?.canal} (sentimiento ${payload.interaction?.sentimiento})`,
      'created'
    );
  });

  socket.on('interaction:updated', (payload) => {
    if (payload?.metrics) {
      renderLiveMetrics(payload.metrics, payload.interaction?.id_interaccion, true);
    }
    showToast(
      'Interacción actualizada',
      `${payload.interaction?.id_interaccion} (sentimiento ${payload.interaction?.sentimiento})`,
      'updated'
    );
  });

  socket.on('interaction:deleted', (payload) => {
    if (payload?.metrics) {
      renderLiveMetrics(payload.metrics, null, true);
    }
    showToast(
      'Interacción eliminada',
      `Registro dado de baja: ${payload.id_interaccion}`,
      'deleted'
    );
  });
}
