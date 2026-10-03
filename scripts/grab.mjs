// Haalt de programmagegevens op van tvgids.nl en schrijft ze als XMLTV naar public/guide.xml.
// Gebaseerd op de iptv-org/epg grabber voor tvgids.nl (sites/tvgids.nl/tvgids.nl.config.js).
//
// Gebruik: node scripts/grab.mjs [--days=3] [--channels=npo1,npo2] [--concurrency=4]

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cheerio from 'cheerio'

const BASE = 'https://www.tvgids.nl'
const TZ = 'Europe/Amsterdam'
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/guide.xml')

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  })
)
const DAYS = Number(args.days ?? 3)
const CONCURRENCY = Number(args.concurrency ?? 4)
const ONLY = args.channels ? new Set(String(args.channels).split(',')) : null

async function get(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EPG-grabber)', 'Accept-Language': 'nl-NL' }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (err) {
      if (i >= tries) throw new Error(`${url}: ${err.message}`)
      await new Promise(r => setTimeout(r, 1000 * i))
    }
  }
}

// Datum (DD-MM-YYYY) in Nederlandse tijd, `offset` dagen vanaf vandaag.
function dayString(offset) {
  const d = new Date(Date.now() + offset * 86400000)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
      .formatToParts(d)
      .map(p => [p.type, p.value])
  )
  return `${parts.day}-${parts.month}-${parts.year}`
}

async function fetchChannels() {
  const $ = cheerio.load(await get(`${BASE}/gids/`))
  const channels = new Map()
  $('.guide__channel-logo-container a[id]').each((_, el) => {
    const id = $(el).attr('id')
    if (!id || channels.has(id)) return
    const img = $(el).find('img')
    channels.set(id, {
      id,
      name: img.attr('title') || $(el).text().trim() || id,
      logo: img.attr('data-src') || img.attr('src') || null
    })
  })
  return [...channels.values()]
}

function parsePrograms(html, channelId) {
  const $ = cheerio.load(html)
  const programs = []
  $('.guide__guide .program').each((_, el) => {
    const $el = $(el)
    const bar = $el.find('.program__progress')
    const start = Number(bar.attr('data-start'))
    const stop = Number(bar.attr('data-eind'))
    if (!start || !stop) return
    const href = $el.find('a.program__info').attr('href') || ''
    const labels = $el
      .find('.program__labels .label')
      .map((_, l) => ($(l).attr('class') || '').match(/label--(?!program)(\w+)/)?.[1])
      .get()
      .filter(Boolean)
    programs.push({
      id: $el.attr('data-episode') || `${channelId}-${start}`,
      channel: channelId,
      start,
      stop,
      title: $el.find('.program__title').text().trim(),
      desc: $el.find('.program__text').text().replace(/\s+/g, ' ').trim(),
      image: $el.find('.program__thumbnail').attr('data-src') || null,
      category: [href.split('/').filter(Boolean)[0]].find(c => c && c !== 'lineair') ?? null,
      url: href ? BASE + href : null,
      rerun: labels.includes('rerun')
    })
  })
  return programs
}

async function grabChannel(channel) {
  const all = new Map()
  for (let d = 0; d < DAYS; d++) {
    const path = d === 0 ? channel.id : `${dayString(d)}/${channel.id}`
    try {
      for (const p of parsePrograms(await get(`${BASE}/gids/${path}`), channel.id)) all.set(p.id, p)
    } catch (err) {
      console.warn(`  ! ${channel.id} dag ${d}: ${err.message}`)
    }
  }
  return [...all.values()].sort((a, b) => a.start - b.start)
}

async function pool(items, size, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i], i)
      }
    })
  )
  return results
}

const esc = s =>
  String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])

function xmltvTime(unix) {
  return new Date(unix * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000'
}

function toXmltv(channels, programs) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<tv date="${xmltvTime(Date.now() / 1000)}" source-info-url="${BASE}" generator-info-name="epg-grabber">`]
  for (const c of channels) {
    out.push(`  <channel id="${esc(c.id)}">`)
    out.push(`    <display-name>${esc(c.name)}</display-name>`)
    if (c.logo) out.push(`    <icon src="${esc(c.logo)}"/>`)
    out.push(`    <url>${BASE}/gids/${esc(c.id)}</url>`)
    out.push('  </channel>')
  }
  for (const p of programs) {
    out.push(`  <programme start="${xmltvTime(p.start)}" stop="${xmltvTime(p.stop)}" channel="${esc(p.channel)}">`)
    out.push(`    <title lang="nl">${esc(p.title)}</title>`)
    if (p.desc) out.push(`    <desc lang="nl">${esc(p.desc)}</desc>`)
    if (p.category) out.push(`    <category lang="nl">${esc(p.category)}</category>`)
    if (p.image) out.push(`    <icon src="${esc(p.image)}"/>`)
    if (p.url) out.push(`    <url>${esc(p.url)}</url>`)
    if (p.rerun) out.push('    <previously-shown/>')
    out.push('  </programme>')
  }
  out.push('</tv>', '')
  return out.join('\n')
}

const t0 = Date.now()
let channels = await fetchChannels()
if (ONLY) channels = channels.filter(c => ONLY.has(c.id))
console.log(`${channels.length} zenders, ${DAYS} dag(en), ${CONCURRENCY} tegelijk`)

const perChannel = await pool(channels, CONCURRENCY, async (c, i) => {
  const progs = await grabChannel(c)
  console.log(`  [${i + 1}/${channels.length}] ${c.name}: ${progs.length} programma's`)
  return progs
})

const programs = perChannel.flat()
await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, toXmltv(channels, programs))
console.log(`Klaar: ${programs.length} programma's → ${OUT} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
