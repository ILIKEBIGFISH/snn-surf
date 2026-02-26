/* ============================================
   Oahu Surf — Fishing & Diving Report
   Swipeable daily cards with all-shores view
   ============================================ */

var CORS_PROXY = 'https://corsproxy.io/?';
var SNN_URL = 'https://www.surfnewsnetwork.com/';
var NOAA_TIDE_URL = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
var HONOLULU_STATION = '1612340';

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

var currentDay = 0;
var totalDays = 0;
var touchStartX = 0;
var touchDeltaX = 0;
var isSwiping = false;

// --- Service Worker ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () { });
}

// --- Init ---
document.addEventListener('DOMContentLoaded', function () {
    loadAllData();
    setupRefresh();
    setupSwipe();
    setupNavButtons();
});

// ============================================
// DATA LOADING
// ============================================

async function loadAllData() {
    showLoading();
    try {
        var results = await Promise.allSettled([fetchSNNData(), fetchTideData()]);
        var snn = results[0].status === 'fulfilled' ? results[0].value : null;
        var tides = results[1].status === 'fulfilled' ? results[1].value : null;

        if (!snn) throw new Error('Could not load surf data.');

        buildDayCards(snn, tides);
        showContent();
        $('#update-time').textContent = formatTime(new Date());
    } catch (err) {
        console.error(err);
        showError(err.message);
    }
}

// ============================================
// FETCH & PARSE
// ============================================

async function fetchSNNData() {
    var response = await fetch(CORS_PROXY + encodeURIComponent(SNN_URL), {
        headers: { 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!response.ok) throw new Error('Failed to fetch surf report');

    var html = await response.text();
    var doc = new DOMParser().parseFromString(html, 'text/html');

    return {
        forecasts: parseForecasts(doc),
        wind: parseWindForecast(doc)
    };
}

// --- Parse Swell Forecasts ---
function parseForecasts(doc) {
    var forecasts = { north: [], west: [], south: [], east: [] };
    var h3s = doc.querySelectorAll('h3');

    for (var i = 0; i < h3s.length; i++) {
        var text = h3s[i].textContent.trim().toLowerCase();
        var shore = null;
        if (text === 'north') shore = 'north';
        else if (text === 'west') shore = 'west';
        else if (text === 'south') shore = 'south';
        else if (text === 'east') shore = 'east';
        if (!shore) continue;

        var el = h3s[i].nextElementSibling;
        var tries = 0;
        while (el && tries < 5) {
            if (el.className && el.className.indexOf('mainbox') !== -1) {
                var days = el.querySelectorAll('.reportday');
                for (var j = 0; j < days.length; j++) {
                    var parsed = parseForecastDay(days[j]);
                    if (parsed) forecasts[shore].push(parsed);
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
    var titleEl = dayEl.querySelector('.titleday');
    var dayLabel = titleEl ? titleEl.textContent.trim() : '';
    if (!dayLabel) return null;

    var tidesEl = dayEl.querySelector('.tidescontent');
    var text = tidesEl ? tidesEl.textContent : dayEl.textContent;

    var result = {
        day: dayLabel, date: '',
        primary: { trend: '', period: '', dir: '', haw: '', face: '' },
        secondary: { trend: '', period: '', dir: '', haw: '', face: '' },
        conditions: ''
    };

    var dm = text.match(/(\d{2}\/\d{2})/);
    if (dm) result.date = dm[1];

    var pi = text.indexOf('Primary');
    var si = text.indexOf('Secondary');

    if (pi >= 0) {
        var pe = si >= 0 ? si : text.length;
        result.primary = parseSwellBlock(text.substring(pi + 7, pe));
    }
    if (si >= 0) {
        result.secondary = parseSwellBlock(text.substring(si + 9));
    }

    // Conditions
    var lastFace = text.lastIndexOf('Face:');
    if (lastFace >= 0) {
        var cm = text.substring(lastFace).match(/Face:\s*[\d\-+./]+\s*([\w][\w\s,'-]*)/);
        if (cm && cm[1].trim().length > 2) result.conditions = cm[1].trim().substring(0, 60);
    }

    return result;
}

function parseSwellBlock(text) {
    var r = { trend: '', period: '', dir: '', haw: '', face: '' };
    var tm = text.match(/(Dropping|Holding|Up\s*&?\s*holding|Rising|Building|Steady|None)/i);
    if (tm) r.trend = tm[1].trim();
    var pm = text.match(/(\d+)s\s*(?:&nbsp;)?\s*([NSEW]{1,3})/i);
    if (pm) {
        r.period = pm[1] + 's';
        // Clean direction: only keep valid compass chars (stop at H from Haw, etc.)
        var dirRaw = pm[2].toUpperCase();
        r.dir = dirRaw.replace(/[^NSEW]/g, '');
    }
    var hm = text.match(/Haw:\s*([\d\-+./]+)/i);
    if (hm) r.haw = hm[1].trim();
    var fm = text.match(/Face:\s*([\d\-+./]+)/i);
    if (fm) r.face = fm[1].trim();
    return r;
}

// --- Parse Wind from Forecast ---
function parseWindForecast(doc) {
    var windByDay = [];
    var h3s = doc.querySelectorAll('h3');
    for (var i = 0; i < h3s.length; i++) {
        var h3Text = h3s[i].textContent.trim().toLowerCase();
        if (h3Text === 'winds' || h3Text.indexOf('wind') === 0) {
            var next = h3s[i].nextElementSibling;
            var tries = 0;
            while (next && tries < 5) {
                if (next.className && next.className.indexOf('mainbox') !== -1) break;
                next = next.nextElementSibling;
                tries++;
            }
            if (next) {
                var rds = next.querySelectorAll('.reportday');
                for (var j = 0; j < rds.length; j++) {
                    var titleEl = rds[j].querySelector('.titleday');
                    var dayName = titleEl ? titleEl.textContent.trim() : '';
                    var contentEl = rds[j].querySelector('.tidescontent') || rds[j];
                    var txt = contentEl.textContent.trim();
                    // Clean up day name from content
                    txt = txt.replace(dayName, '').trim();
                    // Try to find mph pattern
                    var wm = txt.match(/(\d+[-–]\d+\s*mph\s*[^.]{0,30})/i);
                    if (!wm) wm = txt.match(/([A-Z]{1,3}\s+(?:trades?|winds?)\s+\d+[-–]\d+\s*mph[^.]{0,20})/i);
                    windByDay.push({
                        day: dayName,
                        value: wm ? wm[1].trim() : txt.substring(0, 80)
                    });
                }
            }
            break;
        }
    }
    return windByDay;
}

// --- Fetch NOAA Tides ---
async function fetchTideData() {
    var today = new Date();
    var endDay = new Date(today);
    endDay.setDate(endDay.getDate() + 6);

    var params = new URLSearchParams({
        begin_date: formatDateParam(today),
        end_date: formatDateParam(endDay),
        station: HONOLULU_STATION,
        product: 'predictions', datum: 'MLLW',
        time_zone: 'lst_ldt', interval: 'hilo',
        units: 'english', application: 'OahuSurf', format: 'json'
    });

    var response = await fetch(NOAA_TIDE_URL + '?' + params);
    if (!response.ok) throw new Error('Tide fetch failed');
    var data = await response.json();
    return data.predictions || [];
}

// Group tides by date: all tides for that calendar day + 1 extra from the next day
function groupTidesByDay(allTides) {
    if (!allTides || allTides.length === 0) return {};

    // Build a map of date -> array of tides (with global index)
    var byDate = {};
    for (var i = 0; i < allTides.length; i++) {
        var td = allTides[i];
        var dateStr = td.t.split(' ')[0]; // 'YYYY-MM-DD'
        if (!byDate[dateStr]) byDate[dateStr] = [];
        byDate[dateStr].push({ t: td.t, v: td.v, type: td.type, index: i });
    }

    // For each date, include ALL tides for that day + the very next tide after
    var result = {};
    var dates = Object.keys(byDate).sort();
    for (var d = 0; d < dates.length; d++) {
        var dayTides = byDate[dates[d]];
        // Copy all tides for this calendar day
        var entries = dayTides.map(function (td) { return { t: td.t, v: td.v, type: td.type }; });

        // Find the next tide after this day's last entry
        var lastIdx = dayTides[dayTides.length - 1].index;
        if (lastIdx + 1 < allTides.length) {
            var next = allTides[lastIdx + 1];
            entries.push({ t: next.t, v: next.v, type: next.type });
        }

        result[dates[d]] = entries;
    }
    return result;
}

// ============================================
// BUILD DAY CARDS
// ============================================

function buildDayCards(snn, tides) {
    var track = $('#cards-track');
    track.innerHTML = '';

    // Group tides by date
    var tidesByDate = groupTidesByDay(tides);
    var tideDates = Object.keys(tidesByDate).sort();

    // Determine how many days we have (use north shore as reference)
    var shores = ['north', 'east', 'south', 'west'];
    var numDays = 0;
    for (var s = 0; s < shores.length; s++) {
        var arr = snn.forecasts[shores[s]];
        if (arr && arr.length > numDays) numDays = arr.length;
    }

    totalDays = numDays;
    if (totalDays === 0) {
        track.innerHTML = '<div class="day-card"><p style="color:var(--text-muted);text-align:center;padding-top:40px;">No forecast data available</p></div>';
        totalDays = 1;
        buildDots();
        goToDay(0);
        return;
    }

    for (var d = 0; d < totalDays; d++) {
        var card = document.createElement('div');
        card.className = 'day-card';

        var html = '';

        // Shore forecasts
        for (var si = 0; si < shores.length; si++) {
            var shore = shores[si];
            var data = snn.forecasts[shore] && snn.forecasts[shore][d];
            if (!data) continue;
            html += buildShoreSection(shore, data);
        }

        // Wind
        var wind = snn.wind && snn.wind[d];
        if (wind) {
            html += '<div class="info-section">' +
                '<div class="info-section-title">🌬 Wind</div>' +
                '<div class="wind-value">' + wind.value + '</div>' +
                '</div>';
        }

        // Tides for this day
        var dayTides = tideDates[d] ? tidesByDate[tideDates[d]] : null;
        if (dayTides && dayTides.length > 0) {
            html += '<div class="info-section">' +
                '<div class="info-section-title">🌊 Tides — Honolulu</div>';
            for (var t = 0; t < dayTides.length; t++) {
                var td = dayTides[t];
                var isHigh = td.type === 'H';
                html += '<div class="tide-row">' +
                    '<span class="tide-icon ' + (isHigh ? 'high' : 'low') + '">' + (isHigh ? '▲' : '▼') + '</span>' +
                    '<span class="tide-label">' + (isHigh ? 'High' : 'Low') + '</span>' +
                    '<span class="tide-time">' + formatTideTime(td.t) + '</span>' +
                    '<span class="tide-height">' + parseFloat(td.v).toFixed(1) + ' ft</span>' +
                    '</div>';
            }
            html += '</div>';
        }

        card.innerHTML = html;
        track.appendChild(card);
    }

    buildDots();
    goToDay(0);
}

function buildShoreSection(shore, data) {
    var shoreNames = { north: 'North', east: 'East', south: 'South', west: 'West' };
    var name = shoreNames[shore] || shore;

    // Determine condition class based on face height
    var condClass = getConditionClass(data.primary.face);

    var html = '<div class="' + condClass + '">';
    html += '<div class="shore-section">';

    // Header
    html += '<div class="shore-header">' +
        '<span class="shore-name">' + name + ' Shore' +
        '<span class="fish-badge">✓ Fishable</span></span>' +
        '<span class="shore-trend">' + (data.primary.trend || '') + '</span>' +
        '</div>';

    // Primary swell
    html += '<div class="shore-data">';
    if (data.primary.face) {
        html += '<span class="face-height">' + data.primary.face + '<small>ft face</small></span>';
    } else if (data.primary.haw) {
        html += '<span class="face-height">' + data.primary.haw + '<small>ft haw</small></span>';
    } else {
        html += '<span class="face-height" style="color:var(--flat-green)">Flat</span>';
    }

    html += '<div class="swell-meta">';
    if (data.primary.haw && data.primary.face) html += '<span>Haw: ' + data.primary.haw + ' ft</span>';
    if (data.primary.period) html += '<span>' + data.primary.period + (data.primary.dir ? ' ' + data.primary.dir : '') + '</span>';
    html += '</div></div>';

    // Secondary swell
    if (data.secondary && data.secondary.face && data.secondary.trend !== 'None') {
        html += '<div class="secondary-row">' +
            '<span class="secondary-label">2nd</span>' +
            '<span class="secondary-face">' + data.secondary.face + ' ft</span>' +
            '<span class="secondary-meta">';
        if (data.secondary.period) html += data.secondary.period;
        if (data.secondary.dir) html += ' ' + data.secondary.dir;
        if (data.secondary.trend) html += ' · ' + data.secondary.trend;
        html += '</span></div>';
    }



    html += '</div></div>';
    return html;
}

function getConditionClass(faceStr) {
    if (!faceStr) return 'condition-flat';
    var m = faceStr.match(/(\d+)/);
    if (!m) return 'condition-flat';
    var maxHeight = parseInt(m[1]);

    // Check if it's a range like "5-9", take the higher number
    var rangeM = faceStr.match(/\d+[-–](\d+)/);
    if (rangeM) maxHeight = parseInt(rangeM[1]);

    if (maxHeight <= 2) return 'condition-flat';
    if (maxHeight <= 4) return 'condition-fair';
    if (maxHeight >= 8) return 'condition-rough';
    return '';
}

// ============================================
// SWIPE NAVIGATION
// ============================================

function setupSwipe() {
    var viewport = $('#cards-viewport');

    var touchStartY = 0;
    var touchDeltaY = 0;
    var directionLocked = false; // 'h' for horizontal, 'v' for vertical

    viewport.addEventListener('touchstart', function (e) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchDeltaX = 0;
        touchDeltaY = 0;
        directionLocked = false;
        isSwiping = false;
    }, { passive: true });

    viewport.addEventListener('touchmove', function (e) {
        touchDeltaX = e.touches[0].clientX - touchStartX;
        touchDeltaY = e.touches[0].clientY - touchStartY;

        // Lock direction on first significant movement
        if (!directionLocked) {
            if (Math.abs(touchDeltaX) > 10 || Math.abs(touchDeltaY) > 10) {
                if (Math.abs(touchDeltaX) > Math.abs(touchDeltaY)) {
                    directionLocked = 'h';
                    isSwiping = true;
                    $('#cards-track').classList.add('swiping');
                } else {
                    directionLocked = 'v';
                }
            }
        }

        // Only move cards track for horizontal swipes
        if (directionLocked === 'h') {
            e.preventDefault();
            var offset = -(currentDay * window.innerWidth) + touchDeltaX;
            $('#cards-track').style.transform = 'translateX(' + offset + 'px)';
        }
    }, { passive: false });

    viewport.addEventListener('touchend', function () {
        if (!isSwiping) return;
        isSwiping = false;
        $('#cards-track').classList.remove('swiping');

        if (touchDeltaX < -50 && currentDay < totalDays - 1) {
            goToDay(currentDay + 1);
        } else if (touchDeltaX > 50 && currentDay > 0) {
            goToDay(currentDay - 1);
        } else {
            goToDay(currentDay); // snap back
        }
        touchDeltaX = 0;
    }, { passive: true });
}

function setupNavButtons() {
    $('#prev-day').addEventListener('click', function () {
        if (currentDay > 0) goToDay(currentDay - 1);
    });
    $('#next-day').addEventListener('click', function () {
        if (currentDay < totalDays - 1) goToDay(currentDay + 1);
    });
}

function goToDay(index) {
    currentDay = index;
    var offset = -(currentDay * 100);
    $('#cards-track').style.transform = 'translateX(' + offset + '%)';

    // Update day label
    var cards = $$('.day-card');
    var dayText = '';
    if (cards[index]) {
        // Get the day name from the first shore section's data
        var firstShore = cards[index].querySelector('.shore-header');
        // Use the forecast data stored on the page
    }

    // Get day label from forecast data
    updateDayLabel(index);
    updateDots(index);

    // Arrow states
    $('#prev-day').disabled = (index === 0);
    $('#next-day').disabled = (index === totalDays - 1);
}

function updateDayLabel(index) {
    // We'll store day labels when building cards
    var labels = window._dayLabels || [];
    var label = labels[index] || 'Day ' + (index + 1);
    $('#day-label').textContent = label;
}

function buildDots() {
    var container = $('#dot-indicators');
    container.innerHTML = '';
    for (var i = 0; i < totalDays; i++) {
        var dot = document.createElement('div');
        dot.className = 'dot' + (i === 0 ? ' active' : '');
        dot.dataset.index = i;
        dot.addEventListener('click', function () {
            goToDay(parseInt(this.dataset.index));
        });
        container.appendChild(dot);
    }
}

function updateDots(index) {
    var dots = $$('.dot');
    dots.forEach(function (d, i) {
        d.classList.toggle('active', i === index);
    });
}

// ============================================
// REFRESH
// ============================================

function setupRefresh() {
    $('#refresh-btn').addEventListener('click', function () {
        this.classList.add('spinning');
        var btn = this;
        loadAllData().finally(function () { btn.classList.remove('spinning'); });
    });

    var retryBtn = $('#retry-btn');
    if (retryBtn) {
        retryBtn.addEventListener('click', function () { loadAllData(); });
    }
}

// ============================================
// UI STATE
// ============================================

function showLoading() {
    $('#loading-screen').classList.remove('hidden');
    $('#error-screen').classList.add('hidden');
    $('#content').classList.add('hidden');
}

function showContent() {
    $('#loading-screen').classList.add('hidden');
    $('#error-screen').classList.add('hidden');
    $('#content').classList.remove('hidden');
}

function showError(msg) {
    $('#loading-screen').classList.add('hidden');
    $('#error-screen').classList.remove('hidden');
    $('#content').classList.add('hidden');
    $('#error-message').textContent = msg || 'Something went wrong.';
}

// ============================================
// HELPERS
// ============================================

function formatTime(d) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDateParam(d) {
    return '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

function formatTideTime(str) {
    var parts = str.split(' ');
    var tp = parts[1].split(':');
    var h = parseInt(tp[0]);
    var min = parseInt(tp[1]);
    return (h % 12 || 12) + ':' + String(min).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
}

// Override buildDayCards to store labels
var _origBuild = buildDayCards;
buildDayCards = function (snn, tides) {
    // Collect day labels from the first shore that has data
    window._dayLabels = [];
    var shores = ['north', 'east', 'south', 'west'];
    var refShore = null;
    for (var s = 0; s < shores.length; s++) {
        if (snn.forecasts[shores[s]] && snn.forecasts[shores[s]].length > 0) {
            refShore = snn.forecasts[shores[s]];
            break;
        }
    }
    if (refShore) {
        for (var d = 0; d < refShore.length; d++) {
            var label = refShore[d].day;
            if (refShore[d].date) label += ' ' + refShore[d].date;
            window._dayLabels.push(label);
        }
    }
    _origBuild(snn, tides);
};
