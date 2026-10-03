# TV-gids

Een statische Nederlandse TV-gids die een XMLTV-bestand (`public/guide.xml`) inleest en toont als tijdlijn en als "Nu op TV"-overzicht.

De kant-en-klare gidsen van iptv-org (`iptv-org.github.io/epg/guides/...`) worden niet meer gehost. Daarom zit er een eigen grabber bij, gebaseerd op de [iptv-org tvgids.nl-config](https://github.com/iptv-org/epg/tree/master/sites/tvgids.nl), die hetzelfde XMLTV-formaat maakt.

## Gebruik

```sh
npm install
npm run grab          # haalt ~120 zenders × 3 dagen op (±30 s) → public/guide.xml
npm start             # http://localhost:8080
```

Opties voor de grabber:

```sh
npm run grab -- --days=5                 # aantal dagen vooruit
npm run grab -- --channels=npo1,npo2,rtl4  # alleen deze zenders
npm run grab -- --concurrency=2          # minder gelijktijdige verzoeken
```

## Functies

- Tijdlijn per tv-dag (06:00–06:00) met rode nu-lijn en kleuren per genre
- "Nu op TV": wat er nu op elke zender is, met voortgang en het volgende programma (`#nu`)
- Zoeken op titel, favoriete zenders (★, bewaard in de browser)
- Programmadetails met afbeelding, beschrijving en link naar tvgids.nl
- Licht/donker volgens systeeminstelling, werkt op mobiel

## Publiceren

`.github/workflows/epg.yml` ververst de gids twee keer per dag en publiceert `public/` naar GitHub Pages. Zet in de repo-instellingen onder **Pages** de bron op **GitHub Actions**.

Elk ander statisch hostingplatform werkt ook: draai `npm run grab` periodiek (bijv. via cron) en serveer de map `public/`.
