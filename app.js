/* ============================================
   SNN Surf — App Logic (v2 - robust text parser)
   ============================================ */

// --- Configuration ---
var CORS_PROXY = 'https://corsproxy.io/?';
var SNN_URL = 'https://www.surfnewsnetwork.com/';
var NOAA_TIDE_URL = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
var HONOLULU_STATION = '1612340';

// --- DOM Helpers ---
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

var loadingScreen, errorScreen, errorMessage, content, updateTime, refreshBtn, retryBtn, pullIndicator;

// --- Service Worker Registration ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () { });
}

// --- Init ---
document.addEventListener('DOMContentLoaded', function () {
    loadingScreen = $('#loading-screen');
    errorScreen = $('#error-screen');
    errorMessage = $('#error-message');
    content = $('#content');
    updateTime = $('#update-time');
    refreshBtn = $('#refresh-btn');
    retryBtn = $('#retry-btn');
    pullIndicator = $('#pull-indicator');

    loadAllData();
    setupRefresh();
    setupPullToRefresh();
    setupForecastTabs();
});

// ============================================
// DATA LOADING
// ============================================

async function loadAllData() {
    showLoading();

    try {
        var results = await Promise.allSettled([
            fetchSNNData(),
            fetchTideData()
        ]);

        var snn = results[0].status === 'fulfilled' ? results[0].value : null;
        var tides = results[1].status === 'fulfilled' ? results[1].value : null;

        if (!snn && !tides) {
            throw new Error('Could not load any data. Please check your connection.');
        }

        if (snn) {
            renderOBS(snn.obs);
            renderShoreReports(snn.shores);
            renderWind(snn.wind);
            renderForecasts(snn.forecasts);
        }

        if (tides) {
            renderTides(tides);
        }

        showContent();
        updateTime.textContent = 'Updated ' + formatTime(new Date());
    } catch (err) {
        console.error('Load error:', err);
        showError(err.message);
    }
}

// ============================================
// FETCH & PARSE SNN
// ============================================

async function fetchSNNData() {
    var response = await fetch(CORS_PROXY + encodeURIComponent(SNN_URL), {
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });

    if (!response.ok) throw new Error('Failed to fetch surf report');

    var html = await response.text();
    var parser = new DOMParser();
    var doc = parser.parseFromString(html, 'text/html');

    var obs = parseOBS(doc);
    var shores = parseShoreReports(doc);
    var wind = parseWind(doc);
    var forecasts = parseForecasts(doc);

    console.log('Parsed data:', { obs: obs, shores: shores, wind: wind, forecasts: forecasts });

    return { obs: obs, shores: shores, wind: wind, forecasts: forecasts };
}

// ============================================
// PARSE OBS - the daily observation header
// ============================================

function parseOBS(doc) {
    var obsTitle = '';
    var obsSummary = '';

    // Find the H2 that contains "OBS" and time
    var h2s = doc.querySelectorAll('h2');
    for (var i = 0; i < h2s.length; i++) {
        var text = h2s[i].textContent.trim();
        if (/\d+\s*[ap]m\s*obs/i.test(text)) {
            obsTitle = text;
            // Walk forward to find the H4 weather summary
            var el = h2s[i].nextElementSibling;
            while (el) {
                if (el.tagName === 'H4' && el.textContent.trim().length > 30) {
                    obsSummary = el.textContent.trim();
                    break;
                }
                if (el.tagName === 'H2') break;
                el = el.nextElementSibling;
            }
            break;
        }
    }

    return { title: obsTitle, summary: obsSummary };
}

// ============================================
// PARSE SHORE REPORTS from OBS section
// Each shore is in a <div class="media-body">
//   <h4 class="media-heading">North Shore:</h4>
//   ...text with wave heights...
// </div>
// ============================================

function parseShoreReports(doc) {
    var shores = [];
    var mediaBodies = doc.querySelectorAll('.media-body');

    console.log('Found ' + mediaBodies.length + ' media-body elements');

    // Define shores we're looking for (order matters - check more specific first)
    var shoreMap = [
        { name: 'North Shore', match: 'north shore:', icon: '🏄' },
        { name: 'West Shore', match: 'west:', icon: '🌅' },
        { name: 'Town (South)', match: 'town:', icon: '🏙️' },
        { name: 'Diamond Head', match: 'diamond head:', icon: '💎' },
        { name: "Sandy's", match: "sandy", icon: '🏖️' },
        { name: "East / Makapu'u", match: 'east makapu', icon: '🌄' }
    ];

    for (var i = 0; i < mediaBodies.length; i++) {
        var mb = mediaBodies[i];
        var h4 = mb.querySelector('h4');
        if (!h4) continue;

        var headingLower = h4.textContent.trim().toLowerCase();

        // Find which shore this heading matches
        var matchedShore = null;
        for (var j = 0; j < shoreMap.length; j++) {
            if (headingLower.indexOf(shoreMap[j].match) !== -1) {
                // Make sure we haven't already added this shore
                var alreadyAdded = false;
                for (var k = 0; k < shores.length; k++) {
                    if (shores[k].name === shoreMap[j].name) { alreadyAdded = true; break; }
                }
                if (!alreadyAdded) {
                    matchedShore = shoreMap[j];
                }
                break;
            }
        }

        if (!matchedShore) continue;

        // Get report text: everything in the media-body after the heading
        var rawText = mb.textContent.trim();
        var headingText = h4.textContent.trim();
        var reportText = rawText.substring(rawText.indexOf(headingText) + headingText.length).trim();

        // Extract wave height
        var height = extractHeight(reportText);

        console.log('Shore: ' + matchedShore.name + ' | Height: ' + height + ' | Text: ' + reportText.substring(0, 80));

        shores.push({
            name: matchedShore.name,
            icon: matchedShore.icon,
            height: height || 'See report',
            details: truncateText(reportText, 120)
        });
    }

    return shores;
}

// Extract the best wave height from report text
function extractHeight(text) {
    // Normalize quotes
    var t = text.replace(/[\u2018\u2019\u2032\u02BB\u02BC\u0060\u00B4\u2033]/g, "'");

    // 1. "Surf's X-X'" pattern (common for Town, Diamond Head, Sandy's, East)
    var m = t.match(/[Ss]urf['s]*\s+(\d[\d.]*[-\u2013](?:occ\.?\s*)?\d[\d.]*'?)/);
    if (m) return m[1];

    // 2. Range with "maybe" (e.g. "3-5' maybe 6'")
    m = t.match(/(\d[\d.]*-\d[\d.]*'?\s*maybe\s*\d[\d.]*'?)/i);
    if (m) return m[1];

    // 3. Range with occ (e.g. "1-occ. 2'")
    m = t.match(/(\d+-occ\.?\s*\d[\d.]*'?)/i);
    if (m) return m[1];

    // 4. Standard range (e.g. "3-5'", "0-1.5'", "are 0-1.5'")
    m = t.match(/(\d[\d.]*-\d[\d.]*')/);
    if (m) return m[1];

    // 5. Height at specific spot (e.g. "Sunset 3-5'")
    m = t.match(/\w+\s+(\d[\d.]*-\d[\d.]*')/);
    if (m) return m[1];

    // 6. Single number with foot mark
    m = t.match(/(\d[\d.]*')/);
    if (m) return m[1];

    return '';
}

// ============================================
// PARSE WIND DATA
// ============================================

function parseWind(doc) {
    var windData = [];

    // Look for the "Winds" H3 heading and its associated content
    var h3s = doc.querySelectorAll('h3');
    for (var i = 0; i < h3s.length; i++) {
        if (h3s[i].textContent.trim().toLowerCase() === 'winds') {
            // The wind data is in the next sibling mainbox
            var next = h3s[i].nextElementSibling;
            if (next) {
                var reportDays = next.querySelectorAll('.reportday');
                for (var j = 0; j < reportDays.length; j++) {
                    var rd = reportDays[j];
                    var titleEl = rd.querySelector('.titleday');
                    var dayName = titleEl ? titleEl.textContent.trim() : 'Day ' + (j + 1);
                    var dayText = rd.textContent.trim();

                    // Extract wind info (e.g. "10-25mph NE Trade")
                    var wm = dayText.match(/(\d+-\d+\s*mph\s*\w+\s*\w*)/i);
                    if (wm) {
                        windData.push({ day: dayName, value: wm[1].trim() });
                    } else {
                        // Try for general weather description
                        var desc = dayText.replace(dayName, '').trim();
                        if (desc.length > 5 && desc.length < 100) {
                            windData.push({ day: dayName, value: desc });
                        }
                    }
                }
            }
            break;
        }
    }

    // Fallback: look in OBS header text
    if (windData.length === 0) {
        var h4s = doc.querySelectorAll('h4');
        for (var i = 0; i < h4s.length; i++) {
            var txt = h4s[i].textContent.trim();
            if (txt.toLowerCase().indexOf('trade') !== -1 && txt.length > 30) {
                var wm = txt.match(/((?:Moderate|Light|Strong|Fresh|Breezy)\s+(?:NE|NW|SE|SW|N|S|E|W|ENE|ESE|WNW|WSW)\s+trades?[^.]*)/i);
                if (wm) {
                    windData.push({ day: 'Today', value: wm[1].trim() });
                }
                break;
            }
        }
    }

    return windData;
}

// ============================================
// PARSE SWELL FORECASTS
// Structure: <h3>North</h3> => <div class="mainbox"> => multiple <div class="reportday">
// Each reportday: <div class="titleday">Wednesday</div> + <div class="tidescontent">...</div>
// ============================================

function parseForecasts(doc) {
    var forecasts = { north: [], west: [], south: [], east: [] };

    // Find forecast H3 headings
    var h3s = doc.querySelectorAll('h3');
    for (var i = 0; i < h3s.length; i++) {
        var text = h3s[i].textContent.trim().toLowerCase();
        var shore = null;

        if (text === 'north') shore = 'north';
        else if (text === 'west') shore = 'west';
        else if (text === 'south') shore = 'south';
        else if (text === 'east') shore = 'east';

        if (!shore) continue;

        // Find next sibling that is a mainbox div
        var el = h3s[i].nextElementSibling;
        var tries = 0;
        while (el && tries < 5) {
            if (el.className && el.className.indexOf('mainbox') !== -1) {
                // Parse each reportday inside
                var days = el.querySelectorAll('.reportday');
                console.log('Forecast ' + shore + ': found ' + days.length + ' reportdays');

                for (var j = 0; j < days.length; j++) {
                    var parsed = parseForecastDay(days[j]);
                    if (parsed) {
                        forecasts[shore].push(parsed);
                    }
                }
                break;
            }
            el = el.nextElementSibling;
            tries++;
        }
    }

    return forecasts;
}

function parseForecastDay(dayEl) {
    // Get day label from titleday
    var titleEl = dayEl.querySelector('.titleday');
    var dayLabel = titleEl ? titleEl.textContent.trim() : '';
    if (!dayLabel) return null;

    // Get the tidescontent with all swell data
    var tidesEl = dayEl.querySelector('.tidescontent');
    if (!tidesEl) {
        // Fallback: use the full text content of the day element
        var fullText = dayEl.textContent;
        if (fullText.indexOf('Primary') === -1) return null;
        return parseForecastText(dayLabel, fullText);
    }

    return parseForecastText(dayLabel, tidesEl.textContent);
}

function parseForecastText(dayLabel, text) {
    var result = {
        day: dayLabel,
        date: '',
        primary: { trend: '', period: '', dir: '', haw: '', face: '' },
        secondary: { trend: '', period: '', dir: '', haw: '', face: '' },
        conditions: ''
    };

    // Extract date
    var dateM = text.match(/(\d{2}\/\d{2})/);
    if (dateM) result.date = dateM[1];

    // Split into Primary and Secondary sections
    var priIdx = text.indexOf('Primary');
    var secIdx = text.indexOf('Secondary');

    if (priIdx >= 0) {
        var priEnd = secIdx >= 0 ? secIdx : text.length;
        var priText = text.substring(priIdx + 7, priEnd);
        result.primary = parseSwellBlock(priText);
    }

    if (secIdx >= 0) {
        var secText = text.substring(secIdx + 9);
        result.secondary = parseSwellBlock(secText);
    }

    // Conditions: look for text after the last "Face:" value
    var lastFaceIdx = text.lastIndexOf('Face:');
    if (lastFaceIdx >= 0) {
        var afterFace = text.substring(lastFaceIdx);
        var condM = afterFace.match(/Face:\s*[\d\-+./]+\s*([\w][\w\s,'-]*)/);
        if (condM && condM[1].trim().length > 2) {
            result.conditions = condM[1].trim().substring(0, 80);
        }
    }

    return result;
}

function parseSwellBlock(text) {
    var result = { trend: '', period: '', dir: '', haw: '', face: '' };

    // Trend: "Dropping", "Holding", "Up & holding", "Rising", "Building", "None"
    var trendM = text.match(/(Dropping|Holding|Up\s*&?\s*holding|Rising|Building|Steady|None)\s*/i);
    if (trendM) result.trend = trendM[1].trim();

    // Period + direction: "14s NNE" or "17s SSW"
    var periodM = text.match(/(\d+)s\s*(?:&nbsp;)?\s*([A-Z]{1,3})/i);
    if (periodM) {
        result.period = periodM[1] + 's';
        result.dir = periodM[2];
    }

    // Hawaiian scale: "Haw: 3-5+"
    var hawM = text.match(/Haw:\s*([\d\-+./]+)/i);
    if (hawM) result.haw = hawM[1].trim();

    // Face height: "Face: 5-9+"
    var faceM = text.match(/Face:\s*([\d\-+./]+)/i);
    if (faceM) result.face = faceM[1].trim();

    return result;
}

// ============================================
// FETCH NOAA TIDE DATA
// ============================================

async function fetchTideData() {
    var today = new Date();
    var tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    var params = new URLSearchParams({
        begin_date: formatDateParam(today),
        end_date: formatDateParam(tomorrow),
        station: HONOLULU_STATION,
        product: 'predictions',
        datum: 'MLLW',
        time_zone: 'lst_ldt',
        interval: 'hilo',
        units: 'english',
        application: 'SNNSurfApp',
        format: 'json'
    });

    var response = await fetch(NOAA_TIDE_URL + '?' + params);
    if (!response.ok) throw new Error('Failed to fetch tide data');

    var data = await response.json();
    return data.predictions || [];
}

// ============================================
// RENDERING
// ============================================

function renderOBS(obs) {
    $('#obs-date').textContent = obs.title || "Today's Observations";
    $('#obs-summary').textContent = obs.summary || 'Surf report data from Surf News Network.';
}

function renderShoreReports(shores) {
    var container = $('#shore-reports');
    container.innerHTML = '';

    if (shores.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;">Shore report data unavailable</p>';
        return;
    }

    for (var i = 0; i < shores.length; i++) {
        var s = shores[i];
        var cls = getHeightClass(s.height);
        var div = document.createElement('div');
        div.className = 'shore-item';
        div.innerHTML =
            '<div class="shore-name">' + s.icon + ' ' + s.name +
            '<span class="shore-spots">' + s.details + '</span></div>' +
            '<div class="shore-height ' + cls + '">' + s.height + '</div>';
        container.appendChild(div);
    }
}

function renderWind(windData) {
    var container = $('#wind-data');
    container.innerHTML = '';

    if (windData.length === 0) {
        container.style.display = 'block';
        container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;">Wind data unavailable</p>';
        return;
    }

    for (var i = 0; i < windData.length; i++) {
        var div = document.createElement('div');
        div.className = 'wind-item';
        div.innerHTML =
            '<div class="wind-day">' + windData[i].day + '</div>' +
            '<div class="wind-value">' + windData[i].value + '</div>';
        container.appendChild(div);
    }
}

function renderTides(tides) {
    var container = $('#tide-data');
    container.innerHTML = '';

    if (!tides || tides.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;">Tide data unavailable</p>';
        return;
    }

    for (var i = 0; i < tides.length; i++) {
        var t = tides[i];
        var isHigh = t.type === 'H';
        var div = document.createElement('div');
        div.className = 'tide-item';
        div.innerHTML =
            '<div class="tide-type-icon ' + (isHigh ? 'high' : 'low') + '">' + (isHigh ? '▲' : '▼') + '</div>' +
            '<div class="tide-info">' +
            '<div class="tide-type">' + (isHigh ? 'High Tide' : 'Low Tide') + '</div>' +
            '<div class="tide-time">' + formatTideTime(t.t) + '</div>' +
            '</div>' +
            '<div class="tide-height">' + parseFloat(t.v).toFixed(1) + ' ft</div>';
        container.appendChild(div);
    }
}

function renderForecasts(forecasts) {
    window._forecasts = forecasts;
    renderForecastShore(forecasts, 'north');
}

function renderForecastShore(forecasts, shore) {
    var container = $('#forecast-content');
    container.innerHTML = '';

    var data = forecasts[shore] || [];

    if (data.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:20px 0;">Forecast data not available for this shore</p>';
        return;
    }

    for (var i = 0; i < data.length; i++) {
        var day = data[i];
        var dateLabel = day.day + (day.date ? ' ' + day.date : '');
        var html = '<div class="forecast-day-label">' + dateLabel + '</div><div class="forecast-swells">';

        // Primary
        if (day.primary && (day.primary.haw || day.primary.face)) {
            html += '<div class="swell-row"><span class="swell-label">Primary' +
                (day.primary.trend ? ' · ' + day.primary.trend : '') +
                '</span><div class="swell-detail">';
            if (day.primary.face) html += '<span class="swell-height">' + day.primary.face + ' ft</span>';
            if (day.primary.haw) html += '<span class="swell-period">Haw: ' + day.primary.haw + '</span>';
            if (day.primary.period) {
                html += '<span class="swell-dir">' + day.primary.period;
                if (day.primary.dir) html += ' ' + day.primary.dir;
                html += '</span>';
            }
            html += '</div></div>';
        }

        // Secondary (skip if "None")
        if (day.secondary && (day.secondary.haw || day.secondary.face) && day.secondary.trend !== 'None') {
            html += '<div class="swell-row"><span class="swell-label">Secondary' +
                (day.secondary.trend ? ' · ' + day.secondary.trend : '') +
                '</span><div class="swell-detail">';
            if (day.secondary.face) html += '<span class="swell-height">' + day.secondary.face + ' ft</span>';
            if (day.secondary.haw) html += '<span class="swell-period">Haw: ' + day.secondary.haw + '</span>';
            if (day.secondary.period) {
                html += '<span class="swell-dir">' + day.secondary.period;
                if (day.secondary.dir) html += ' ' + day.secondary.dir;
                html += '</span>';
            }
            html += '</div></div>';
        }

        html += '</div>';
        if (day.conditions) html += '<div class="forecast-conditions">' + day.conditions + '</div>';

        var div = document.createElement('div');
        div.className = 'forecast-day';
        div.innerHTML = html;
        container.appendChild(div);
    }
}

// ============================================
// FORECAST TABS
// ============================================

function setupForecastTabs() {
    var tabs = $$('.tab');
    tabs.forEach(function (tab) {
        tab.addEventListener('click', function () {
            tabs.forEach(function (t) { t.classList.remove('active'); });
            tab.classList.add('active');
            if (window._forecasts) {
                renderForecastShore(window._forecasts, tab.dataset.shore);
            }
        });
    });
}

// ============================================
// REFRESH & PULL-TO-REFRESH
// ============================================

function setupRefresh() {
    refreshBtn.addEventListener('click', function () {
        refreshBtn.classList.add('spinning');
        loadAllData().finally(function () {
            refreshBtn.classList.remove('spinning');
        });
    });

    retryBtn.addEventListener('click', function () {
        loadAllData();
    });
}

function setupPullToRefresh() {
    var startY = 0;
    var pulling = false;

    document.addEventListener('touchstart', function (e) {
        if (window.scrollY === 0) {
            startY = e.touches[0].clientY;
            pulling = true;
        }
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
        if (!pulling) return;
        if (e.touches[0].clientY - startY > 80) {
            pullIndicator.classList.add('visible');
        }
    }, { passive: true });

    document.addEventListener('touchend', function () {
        if (pullIndicator.classList.contains('visible')) {
            loadAllData().finally(function () {
                pullIndicator.classList.remove('visible');
            });
        }
        pulling = false;
    }, { passive: true });
}

// ============================================
// UI STATE
// ============================================

function showLoading() {
    loadingScreen.classList.remove('hidden');
    errorScreen.classList.add('hidden');
    content.classList.add('hidden');
}

function showContent() {
    loadingScreen.classList.add('hidden');
    errorScreen.classList.add('hidden');
    content.classList.remove('hidden');
}

function showError(msg) {
    loadingScreen.classList.add('hidden');
    errorScreen.classList.remove('hidden');
    content.classList.add('hidden');
    errorMessage.textContent = msg || 'Something went wrong.';
}

// ============================================
// HELPERS
// ============================================

function formatTime(date) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDateParam(date) {
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return '' + y + m + d;
}

function formatTideTime(str) {
    var parts = str.split(' ');
    var tp = parts[1].split(':');
    var h = parseInt(tp[0]);
    var min = parseInt(tp[1]);
    var ampm = h >= 12 ? 'PM' : 'AM';
    return (h % 12 || 12) + ':' + String(min).padStart(2, '0') + ' ' + ampm;
}

function getHeightClass(height) {
    var m = height.match(/(\d+)/);
    if (!m) return '';
    var n = parseInt(m[1]);
    if (n >= 10) return 'xxl';
    if (n >= 5) return 'pumping';
    if (n <= 1) return 'flat';
    return '';
}

function truncateText(text, max) {
    if (text.length <= max) return text;
    return text.substring(0, max) + '...';
}
