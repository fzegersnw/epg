// TV-gids: leest een XMLTV-bestand (guide.xml) en toont het als tijdlijn en als "Nu op TV".
'use strict'

const SOURCE = 'guide.xml'
const TZ = 'Europe/Amsterdam'
const DAY_START_HOUR = 6 // een tv-dag loopt van 06:00 tot 06:00
const PX_PER_MIN = 5
const MIN = 60000

const $ = id => document.getElementById(id)
const state = {
  channels: [], // {id, name, logo, programs: []}
  days: [], // 'YYYY-MM-DD'
  day: null,
  view: 'grid',
  query: '',
  favOnly: false,
  favs: new Set(load('favs', []))
}

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem('epg.' + key)) ?? fallback } catch { return fallback }
}
function save(key, value) {
  try { localStorage.setItem('epg.' + key, JSON.stringify(value)) } catch {}
}

// ---------- Tijd ----------

const fmtTime = new Intl.DateTimeFormat('nl-NL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
const fmtDay = new Intl.DateTimeFormat('nl-NL', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
const fmtLong = new Intl.DateTimeFormat('nl-NL', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' })
const fmtParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
})

function zoned(ms) {
  const p = Object.fromEntries(fmtParts.formatToParts(ms).map(x => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute }
}

// Epoch (ms) voor een lokale Amsterdamse tijd.
function amsterdamToEpoch(y, m, d, h) {
  const guess = Date.UTC(y, m - 1, d, h)
  const z = zoned(guess)
  const offset = Date.UTC(z.y, z.m - 1, z.d, z.h, z.min) - guess
  return guess - offset
}

function tvDay(ms) {
  return zoned(ms - DAY_START_HOUR * 3600000).date
}

function dayWindow(day) {
  const [y, m, d] = day.split('-').map(Number)
  const start = amsterdamToEpoch(y, m, d, DAY_START_HOUR)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  const end = amsterdamToEpoch(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), DAY_START_HOUR)
  return { start, end }
}

// XMLTV-tijd: "20261002233500 +0000"
function parseXmltvTime(s) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?\s*([+-])?(\d\d)?(\d\d)?/.exec(s || '')
  if (!m) return NaN
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0))
  const off = m[7] ? (m[7] === '-' ? -1 : 1) * ((+m[8] || 0) * 60 + (+m[9] || 0)) * MIN : 0
  return utc - off
}

// ---------- Data ----------

async function loadGuide() {
  const res = await fetch(SOURCE, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`${SOURCE} niet gevonden (HTTP ${res.status}). Draai eerst "npm run grab".`)
  const doc = new DOMParser().parseFromString(await res.text(), 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error(`${SOURCE} is geen geldig XML-bestand.`)

  const byId = new Map()
  for (const el of doc.querySelectorAll('tv > channel')) {
    byId.set(el.getAttribute('id'), {
      id: el.getAttribute('id'),
      name: el.querySelector('display-name')?.textContent ?? el.getAttribute('id'),
      logo: el.querySelector('icon')?.getAttribute('src') ?? null,
      programs: []
    })
  }
  for (const el of doc.querySelectorAll('tv > programme')) {
    const ch = byId.get(el.getAttribute('channel'))
    if (!ch) continue
    const start = parseXmltvTime(el.getAttribute('start'))
    const stop = parseXmltvTime(el.getAttribute('stop'))
    if (!(stop > start)) continue
    ch.programs.push({
      channel: ch,
      start,
      stop,
      title: el.querySelector('title')?.textContent ?? '',
      desc: el.querySelector('desc')?.textContent ?? '',
      category: el.querySelector('category')?.textContent ?? '',
      image: el.querySelector('icon')?.getAttribute('src') ?? null,
      url: el.querySelector('url')?.textContent ?? null,
      rerun: !!el.querySelector('previously-shown')
    })
  }
  for (const ch of byId.values()) ch.programs.sort((a, b) => a.start - b.start)

  const today = tvDay(Date.now())
  const days = new Set()
  for (const ch of byId.values()) for (const p of ch.programs) days.add(tvDay(p.start))

  state.channels = [...byId.values()].filter(c => c.programs.length)
  state.days = [...days].filter(d => d >= today).sort()
  state.day = state.days.includes(today) ? today : state.days[0]
  state.generated = parseXmltvTime(doc.documentElement.getAttribute('date'))
}

function catClass(cat) {
  const c = (cat || '').toLowerCase()
  if (/film|pelicula|short/.test(c)) return 'cat-films'
  if (/serie|dizi/.test(c)) return 'cat-series'
  if (/sport|voetbal|fu-ball|motor/.test(c)) return 'cat-sport'
  if (/nieuws|notizie|haber|nachricht|informations|informacion/.test(c)) return 'cat-nieuws'
  if (/informatief|info|natuur|nature|natura|wetenschap|document|belgesel|magazine|kunst|cultu|kultur/.test(c)) return 'cat-info'
  if (/amusement|entertain|divert|eglence|muziek|musi|talk/.test(c)) return 'cat-amusement'
  if (/jeugd|kids|cocuk/.test(c)) return 'cat-kids'
  return ''
}

function catLabel(cat) {
  return (cat || '').replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase())
}

function visibleChannels() {
  return state.favOnly ? state.channels.filter(c => state.favs.has(c.id)) : state.channels
}

function matches(p) {
  return !state.query || p.title.toLowerCase().includes(state.query)
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// ---------- Weergave: dagen ----------

function renderDays() {
  const today = tvDay(Date.now())
  const tomorrow = tvDay(Date.now() + 86400000)
  $('days').innerHTML = state.days
    .map(d => {
      const label = d === today ? 'Vandaag' : d === tomorrow ? 'Morgen' : fmtDay.format(dayWindow(d).start)
      return `<button data-day="${d}" aria-current="${d === state.day}">${label}</button>`
    })
    .join('')
}

// ---------- Weergave: gids ----------

function renderGrid() {
  const { start, end } = dayWindow(state.day)
  const now = Date.now()
  const width = ((end - start) / MIN) * PX_PER_MIN
  const x = t => ((t - start) / MIN) * PX_PER_MIN
  const channels = visibleChannels()

  const ticks = []
  for (let t = start; t < end; t += 30 * MIN) {
    ticks.push(`<div class="tick" style="left:${x(t)}px">${fmtTime.format(t)}</div>`)
  }

  const rows = channels.map(ch => {
    const progs = ch.programs
      .filter(p => p.stop > start && p.start < end)
      .map(p => {
        const left = x(Math.max(p.start, start))
        const w = x(Math.min(p.stop, end)) - left
        const cls = [
          'prog',
          catClass(p.category),
          p.stop <= now ? 'past' : p.start <= now ? 'live' : '',
          state.query ? (matches(p) ? 'hit' : 'dim') : ''
        ].join(' ')
        return `<button class="${cls}" style="left:${left}px;width:${Math.max(w - 2, 2)}px" data-ch="${esc(ch.id)}" data-start="${p.start}" title="${esc(p.title)}">
          <span class="t">${esc(p.title)}</span><span class="s">${fmtTime.format(p.start)} – ${fmtTime.format(p.stop)}</span></button>`
      })
      .join('')
    return `<div class="row">${channelCell(ch)}<div class="lane" style="width:${width}px">${progs}</div></div>`
  })

  const nowLine =
    now >= start && now < end
      ? `<div class="nowline" id="nowline" style="left:calc(var(--ch-w) + ${x(now)}px)"></div>`
      : ''

  $('grid').innerHTML =
    `<div class="ruler"><div class="corner"></div><div class="ticks" style="width:${width}px">${ticks.join('')}</div></div>` +
    (rows.length ? rows.join('') : emptyMessage()) +
    nowLine

  const line = $('nowline')
  if (line) line.style.height = $('grid').scrollHeight + 'px'
}

function channelCell(ch) {
  const fav = state.favs.has(ch.id)
  return `<div class="ch">
    ${ch.logo ? `<img src="${esc(ch.logo)}" alt="" loading="lazy">` : ''}
    <span class="name" title="${esc(ch.name)}">${esc(ch.name)}</span>
    <button class="star" data-fav="${esc(ch.id)}" aria-pressed="${fav}" aria-label="${esc(ch.name)} als favoriet">★</button>
  </div>`
}

function emptyMessage() {
  return `<p class="status">Nog geen favoriete zenders. Klik op ★ bij een zender om hem toe te voegen.</p>`
}

function scrollToNow(smooth) {
  const grid = $('grid')
  const { start, end } = dayWindow(state.day)
  const now = Date.now()
  const target = now >= start && now < end ? ((now - start) / MIN) * PX_PER_MIN - 60 * PX_PER_MIN : 0
  grid.scrollTo({ left: Math.max(0, target), behavior: smooth ? 'smooth' : 'auto' })
}

// ---------- Weergave: nu op TV ----------

function renderNow() {
  const now = Date.now()
  const cards = visibleChannels()
    .map(ch => {
      const i = ch.programs.findIndex(p => p.start <= now && p.stop > now)
      const cur = ch.programs[i]
      const next = i >= 0 ? ch.programs[i + 1] : ch.programs.find(p => p.start > now)
      if (state.query && !(cur && matches(cur)) && !(next && matches(next))) return ''
      const pct = cur ? Math.round(((now - cur.start) / (cur.stop - cur.start)) * 100) : 0
      return `<article class="card">
        <header>
          ${ch.logo ? `<img src="${esc(ch.logo)}" alt="" loading="lazy">` : ''}
          <span class="name">${esc(ch.name)}</span>
          <button class="star" data-fav="${esc(ch.id)}" aria-pressed="${state.favs.has(ch.id)}" aria-label="${esc(ch.name)} als favoriet">★</button>
        </header>
        ${
          cur
            ? `<button class="cur" data-ch="${esc(ch.id)}" data-start="${cur.start}">
                ${cur.image ? `<img src="${esc(cur.image)}" alt="" loading="lazy">` : ''}
                <span><span class="t">${esc(cur.title)}</span><br><span class="s">${fmtTime.format(cur.start)} – ${fmtTime.format(cur.stop)} · nog ${Math.ceil((cur.stop - now) / MIN)} min</span></span>
              </button>
              <div class="bar"><span style="width:${pct}%"></span></div>`
            : `<span class="s">Geen uitzending</span>`
        }
        ${next ? `<button class="next" data-ch="${esc(ch.id)}" data-start="${next.start}"><b>${fmtTime.format(next.start)}</b> ${esc(next.title)}</button>` : ''}
      </article>`
    })
    .join('')
  $('now').innerHTML = cards || (state.favOnly ? emptyMessage() : `<p class="status">Niets gevonden.</p>`)
}

// ---------- Detail ----------

function openDetail(chId, start) {
  const ch = state.channels.find(c => c.id === chId)
  const p = ch?.programs.find(x => x.start === start)
  if (!p) return
  $('dImg').hidden = !p.image
  if (p.image) $('dImg').src = p.image
  $('dMeta').textContent = [ch.name, catLabel(p.category), p.rerun ? 'Herhaling' : ''].filter(Boolean).join(' · ')
  $('dTitle').textContent = p.title
  $('dTime').textContent = `${fmtLong.format(p.start)}, ${fmtTime.format(p.start)} – ${fmtTime.format(p.stop)} (${Math.round((p.stop - p.start) / MIN)} min)`
  $('dDesc').textContent = p.desc || 'Geen beschrijving beschikbaar.'
  $('dLink').hidden = !p.url
  if (p.url) $('dLink').href = p.url
  $('detail').showModal()
}

// ---------- Samenstellen ----------

function render() {
  renderDays()
  $('grid').hidden = state.view !== 'grid'
  $('now').hidden = state.view !== 'now'
  $('days').style.visibility = state.view === 'grid' ? 'visible' : 'hidden'
  $('jumpNow').hidden = state.view !== 'grid'
  if (state.view === 'grid') renderGrid()
  else renderNow()
}

function bindEvents() {
  $('days').addEventListener('click', e => {
    const b = e.target.closest('[data-day]')
    if (!b) return
    state.day = b.dataset.day
    render()
    scrollToNow(false)
  })

  document.querySelector('.seg').addEventListener('click', e => {
    const b = e.target.closest('[data-view]')
    if (!b) return
    state.view = b.dataset.view
    save('view', state.view)
    history.replaceState(null, '', state.view === 'now' ? '#nu' : '#gids')
    document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-selected', x === b))
    render()
    if (state.view === 'grid') scrollToNow(false)
  })

  let t
  $('search').addEventListener('input', e => {
    clearTimeout(t)
    t = setTimeout(() => {
      state.query = e.target.value.trim().toLowerCase()
      render()
    }, 150)
  })

  $('favToggle').addEventListener('click', e => {
    state.favOnly = !state.favOnly
    e.currentTarget.setAttribute('aria-pressed', state.favOnly)
    save('favOnly', state.favOnly)
    render()
  })

  $('jumpNow').addEventListener('click', () => {
    const today = tvDay(Date.now())
    if (state.day !== today && state.days.includes(today)) {
      state.day = today
      render()
    }
    scrollToNow(true)
  })

  document.querySelector('main').addEventListener('click', e => {
    const star = e.target.closest('[data-fav]')
    if (star) {
      const id = star.dataset.fav
      state.favs.has(id) ? state.favs.delete(id) : state.favs.add(id)
      save('favs', [...state.favs])
      render()
      return
    }
    const prog = e.target.closest('[data-start]')
    if (prog) openDetail(prog.dataset.ch, Number(prog.dataset.start))
  })

  $('detail').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.close()
  })

  // Elke minuut de nu-lijn en de "Nu op TV"-kaarten bijwerken.
  setInterval(() => {
    const scroll = { left: $('grid').scrollLeft, top: $('grid').scrollTop }
    render()
    $('grid').scrollTo(scroll)
  }, MIN)
}

async function init() {
  try {
    await loadGuide()
  } catch (err) {
    $('status').textContent = err.message
    return
  }
  if (!state.channels.length) {
    $('status').textContent = 'Het gidsbestand bevat geen programma’s.'
    return
  }
  $('status').remove()

  const hashView = { '#nu': 'now', '#gids': 'grid' }[location.hash]
  state.view = hashView ?? (load('view', 'grid') === 'now' ? 'now' : 'grid')
  state.favOnly = load('favOnly', false) && state.favs.size > 0
  $('favToggle').setAttribute('aria-pressed', state.favOnly)
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-selected', b.dataset.view === state.view))

  const updated = isNaN(state.generated) ? '' : ` · bijgewerkt ${fmtDay.format(state.generated)} ${fmtTime.format(state.generated)}`
  $('foot').innerHTML = `${state.channels.length} zenders${updated} · gegevens: <a href="https://www.tvgids.nl" target="_blank" rel="noopener">tvgids.nl</a> via XMLTV`

  bindEvents()
  render()
  scrollToNow(false)
}

init()
