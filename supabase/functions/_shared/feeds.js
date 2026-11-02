/* =============================================================================
   Al-Marsad — feed hints
   -----------------------------------------------------------------------------
   A known RSS/Atom endpoint is by far the most reliable way to list a
   publisher's latest articles (far better than scraping a homepage). These are
   hints only: if a feed fails or has moved, the pipeline falls back to
   <link rel="alternate"> discovery and then to link extraction.
   ============================================================================= */

export const FEED_HINTS = {
  // UK / Ireland
  "bbc.com": "https://feeds.bbci.co.uk/news/rss.xml",
  "bbc.co.uk": "https://feeds.bbci.co.uk/news/rss.xml",
  "theguardian.com": "https://www.theguardian.com/international/rss",
  "independent.co.uk": "https://www.independent.co.uk/news/rss",
  "news.sky.com": "https://feeds.skynews.com/feeds/rss/world.xml",
  "telegraph.co.uk": "https://www.telegraph.co.uk/rss.xml",
  "ft.com": "https://www.ft.com/rss/home",
  "economist.com": "https://www.economist.com/the-world-this-week/rss.xml",
  "irishtimes.com": "https://www.irishtimes.com/arc/outboundfeeds/rss/",
  "rte.ie": "https://www.rte.ie/news/rss/news-headlines.xml",

  // France / Belgium / Switzerland
  "france24.com": "https://www.france24.com/en/rss",
  "rfi.fr": "https://www.rfi.fr/en/rss",
  "lemonde.fr": "https://www.lemonde.fr/rss/une.xml",
  "liberation.fr": "https://www.liberation.fr/arc/outboundfeeds/rss/",
  "20minutes.fr": "https://www.20minutes.fr/feeds/rss-une.xml",
  "ouest-france.fr": "https://www.ouest-france.fr/rss/une",
  "lefigaro.fr": "https://www.lefigaro.fr/rss/figaro_actualites.xml",
  "lesoir.be": "https://www.lesoir.be/feed/Actualit%C3%A9s/destination",
  "rtbf.be": "https://www.rtbf.be/api/partner/rss/14",
  "swissinfo.ch": "https://www.swissinfo.ch/ara/rss",
  "nzz.ch": "https://www.nzz.ch/recent.rss",
  "srf.ch": "https://www.srf.ch/news/bnf/rss/1646",

  // Germany / Austria
  "dw.com": "https://rss.dw.com/rdf/rss-en-all",
  "tagesschau.de": "https://www.tagesschau.de/xml/rss2/",
  "taz.de": "https://taz.de/!p4608;rss/",
  "spiegel.de": "https://www.spiegel.de/international/index.rss",
  "zeit.de": "https://newsfeed.zeit.de/index",
  "sueddeutsche.de": "https://rss.sueddeutsche.de/rss/Topthemen",
  "orf.at": "https://rss.orf.at/news.xml",
  "derstandard.at": "https://www.derstandard.at/rss",

  // Nordics
  "svt.se": "https://www.svt.se/rss.xml",
  "dn.se": "https://www.dn.se/rss/",
  "aftonbladet.se": "https://www.aftonbladet.se/rss.xml",
  "nrk.no": "https://www.nrk.no/toppsaker.rss",
  "vg.no": "https://www.vg.no/rss/feed/",
  "aftenposten.no": "https://www.aftenposten.no/rss",
  "dr.dk": "https://www.dr.dk/nyheder/service/feeds/allenyheder",
  "yle.fi": "https://feeds.yle.fi/uutiset/v1/majorHeadlines/YLE_NEWS.rss?language=en",
  "hs.fi": "https://www.hs.fi/rss/tuoreimmat.xml",

  // Russia / Ukraine / Caucasus
  "rt.com": "https://www.rt.com/rss/",
  "tass.com": "https://tass.com/rss/v2.xml",
  "meduza.io": "https://meduza.io/rss/en/all",
  "novayagazeta.eu": "https://novayagazeta.eu/feed",
  "themoscowtimes.com": "https://www.themoscowtimes.com/rss/news",
  "kyivindependent.com": "https://kyivindependent.com/feed/",
  "pravda.com.ua": "https://www.pravda.com.ua/rss/",
  "unian.info": "https://www.unian.info/rss/all.xml",

  // Southern Europe
  "elpais.com": "https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada",
  "elmundo.es": "https://e00-elmundo.uecdn.es/elmundo/rss/portada.xml",
  "20minutos.es": "https://www.20minutos.es/rss/",
  "rtve.es": "https://www.rtve.es/api/noticias.rss",
  "publico.es": "https://www.publico.es/rss/",
  "ansa.it": "https://www.ansa.it/sito/ansait_rss.xml",
  "rainews.it": "https://www.rainews.it/rss/tutti",
  "ilpost.it": "https://www.ilpost.it/feed/",
  "repubblica.it": "https://www.repubblica.it/rss/homepage/rss2.0.xml",
  "corriere.it": "https://xml2.corriereobjects.it/rss/homepage.xml",
  "ertnews.gr": "https://www.ertnews.gr/feed/",
  "kathimerini.gr": "https://www.kathimerini.gr/feed/",

  // Central / Eastern Europe
  "tvn24.pl": "https://tvn24.pl/najnowsze.xml",
  "wyborcza.pl": "https://wyborcza.pl/pub/rss/najnowsze_wyborcza.xml",
  "ct24.ceskatelevize.cz": "https://ct24.ceskatelevize.cz/rss/hlavni-zpravy",
  "idnes.cz": "https://www.idnes.cz/rss.aspx",
  "telex.hu": "https://telex.hu/rss",
  "index.hu": "https://index.hu/24ora/rss/",
  "hvg.hu": "https://hvg.hu/rss",
  "digi24.ro": "https://www.digi24.ro/rss",
  "hotnews.ro": "https://hotnews.ro/feed",
  "dnevnik.bg": "https://www.dnevnik.bg/rss/",
  "b92.net": "https://www.b92.net/rss/",
  "index.hr": "https://www.index.hr/rss",

  // Turkey / Middle East
  "aa.com.tr": "https://www.aa.com.tr/en/rss/default?cat=guncel",
  "dailysabah.com": "https://www.dailysabah.com/rss",
  "hurriyetdailynews.com": "https://www.hurriyetdailynews.com/rss",
  "aljazeera.com": "https://www.aljazeera.com/xml/rss/all.xml",
  "aljazeera.net": "https://www.aljazeera.net/aljazeerarss/a7c186be-1baa-4bd4-9d80-a84db769f779/73d0e1b4-532f-45ef-a1d6-1eb29b02f0b7",
  "arabnews.com": "https://www.arabnews.com/rss.xml",
  "thenationalnews.com": "https://www.thenationalnews.com/arc/outboundfeeds/rss/",
  "gulfnews.com": "https://gulfnews.com/rss",
  "jordantimes.com": "https://jordantimes.com/rss.xml",
  "timesofisrael.com": "https://www.timesofisrael.com/feed/",
  "haaretz.com": "https://www.haaretz.com/srv/haaretz-latest-headlines",
  "972mag.com": "https://www.972mag.com/feed/",
  "tehrantimes.com": "https://www.tehrantimes.com/rss",
  "rudaw.net": "https://www.rudaw.net/api/rss/arabic",

  // Africa
  "news24.com": "https://feeds.24.com/articles/news24/TopStories/rss",
  "mg.co.za": "https://mg.co.za/feed/",
  "nation.africa": "https://nation.africa/kenya/rss",
  "premiumtimesng.com": "https://www.premiumtimesng.com/feed",
  "punchng.com": "https://punchng.com/feed/",
  "theeastafrican.co.ke": "https://www.theeastafrican.co.ke/tea/rss",
  "egyptindependent.com": "https://www.egyptindependent.com/feed/",
  "dailynewsegypt.com": "https://www.dailynewsegypt.com/feed/",
  "moroccoworldnews.com": "https://www.moroccoworldnews.com/feed/",
  "hespress.com": "https://www.hespress.com/feed",

  // South / East / South-East Asia
  "scmp.com": "https://www.scmp.com/rss/91/feed",
  "channelnewsasia.com": "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml",
  "straitstimes.com": "https://www.straitstimes.com/news/world/rss.xml",
  "japantimes.co.jp": "https://www.japantimes.co.jp/feed/",
  "koreaherald.com": "https://www.koreaherald.com/common/rss_xml.php?ct=020000000000",
  "en.yna.co.kr": "https://en.yna.co.kr/RSS/news.xml",
  "indianexpress.com": "https://indianexpress.com/feed/",
  "thehindu.com": "https://www.thehindu.com/news/feeder/default.rss",
  "thewire.in": "https://thewire.in/rss",
  "ndtv.com": "https://feeds.feedburner.com/ndtvnews-top-stories",
  "timesofindia.indiatimes.com": "https://timesofindia.indiatimes.com/rssfeedstopstories.cms",
  "dawn.com": "https://www.dawn.com/feeds/home",
  "tribune.com.pk": "https://tribune.com.pk/feed/home",
  "thenews.com.pk": "https://www.thenews.com.pk/rss/1/1",
  "thedailystar.net": "https://www.thedailystar.net/rss.xml",
  "kathmandupost.com": "https://kathmandupost.com/rss",
  "thejakartapost.com": "https://www.thejakartapost.com/rss",
  "en.antaranews.com": "https://en.antaranews.com/rss/news.xml",
  "thestar.com.my": "https://www.thestar.com.my/rss/News",
  "bangkokpost.com": "https://www.bangkokpost.com/rss/data/topstories.xml",
  "nationthailand.com": "https://www.nationthailand.com/rss",

  // Americas
  "cnn.com": "http://rss.cnn.com/rss/edition.rss",
  "nytimes.com": "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
  "washingtonpost.com": "https://feeds.washingtonpost.com/rss/world",
  "npr.org": "https://feeds.npr.org/1001/rss.xml",
  "politico.com": "https://rss.politico.com/politics-news.xml",
  "axios.com": "https://api.axios.com/feed/",
  "cnbc.com": "https://www.cnbc.com/id/100003114/device/rss/rss.html",
  "bloomberg.com": "https://feeds.bloomberg.com/markets/news.rss",
  "latimes.com": "https://www.latimes.com/world-nation/rss2.0.xml",
  "theatlantic.com": "https://www.theatlantic.com/feed/all/",
  "foreignpolicy.com": "https://foreignpolicy.com/feed/",
  "clarin.com": "https://www.clarin.com/rss/lo-ultimo/",
  "lanacion.com.ar": "https://www.lanacion.com.ar/arc/outboundfeeds/rss/",
  "folha.uol.com.br": "https://feeds.folha.uol.com.br/emcimadahora/rss091.xml",
  "eluniversal.com.mx": "https://www.eluniversal.com.mx/rss.xml",
  "eltiempo.com": "https://www.eltiempo.com/rss/",
  "elcomercio.pe": "https://elcomercio.pe/arc/outboundfeeds/rss/",
  "biobiochile.cl": "https://www.biobiochile.cl/lista/rss",
  "bbc.co.uk/news": "https://feeds.bbci.co.uk/news/rss.xml"
};

const HOST_KEYS = Object.keys(FEED_HINTS).sort((a, b) => b.length - a.length);

/** Return the best feed hint for a URL's host, if any. */
export function feedHintFor(url) {
  let host = "";
  try { host = new URL(url).host.replace(/^www\./, ""); } catch (e) { return null; }
  for (const key of HOST_KEYS) {
    if (host === key || host.endsWith("." + key)) return FEED_HINTS[key];
  }
  return null;
}
