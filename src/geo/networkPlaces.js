'use strict';

// Where the internet's routers stand, by the codes operators put in their names.
//
// A backbone router's reverse-DNS name nearly always carries its city:
//   ae3.cph-bb1.telia.net · kbn-bb6-link.ip.twelve99.net · core1.fra1.he.net
//   be2376.ccr41.fra03.atlas.cogentco.com · ae-5.r20.frnkge08.de.bb.gin.ntt.net
// The codes are IATA airport codes (cph, fra, ams), carrier house codes (kbn and
// ffm at Arelion, adm for Amsterdam), NTT-style CLLI (frnkge, amstnl) and plain
// city names. src/geo/hostnameHints.js reads a name against this table.
//
// CURATED, NOT EXHAUSTIVE. The full IATA list has ~9000 codes and most of them
// collide with words a router name uses for something else (`bdr`, `cor`, `gw`,
// `tor` = top-of-rack, `man` = metro area network, `str`, `per`, `los`, `del`).
// Only codes that are (a) where networks actually interconnect and (b) do not
// mean anything else in a router name are here. A code missing from the table
// costs a hop its city — it falls back to GeoIP — while a wrong code puts it in
// the wrong city, so when in doubt leave it out. Every placement is still
// checked against the hop's round-trip time (src/geo/hopLocation.js).
//
// Coordinates are city centres, 4 decimals. `codes` are lower case.

const PLACES = [
  // --- Nordics ---------------------------------------------------------------
  { city: 'Copenhagen', country: 'DK', lat: 55.6761, lng: 12.5683, codes: ['cph', 'kbn', 'kbh', 'copenhagen', 'kobenhavn', 'koebenhavn'] },
  { city: 'Aarhus', country: 'DK', lat: 56.1629, lng: 10.2039, codes: ['aar', 'arh', 'aarhus', 'arhus'] },
  { city: 'Aalborg', country: 'DK', lat: 57.0488, lng: 9.9217, codes: ['aal', 'aalborg'] },
  { city: 'Odense', country: 'DK', lat: 55.4038, lng: 10.4024, codes: ['ode', 'odense'] },
  { city: 'Esbjerg', country: 'DK', lat: 55.4765, lng: 8.4594, codes: ['ebj', 'esbjerg'] },
  { city: 'Kolding', country: 'DK', lat: 55.4904, lng: 9.4722, codes: ['kolding'] },
  { city: 'Vejle', country: 'DK', lat: 55.7093, lng: 9.5357, codes: ['vejle'] },
  { city: 'Herning', country: 'DK', lat: 56.1393, lng: 8.9738, codes: ['herning'] },
  { city: 'Stockholm', country: 'SE', lat: 59.3293, lng: 18.0686, codes: ['sto', 'sth', 'arn', 'stockholm'] },
  { city: 'Gothenburg', country: 'SE', lat: 57.7089, lng: 11.9746, codes: ['got', 'gbg', 'gothenburg', 'goteborg'] },
  { city: 'Malmö', country: 'SE', lat: 55.605, lng: 13.0038, codes: ['mmx', 'mmo', 'malmo'] },
  { city: 'Oslo', country: 'NO', lat: 59.9139, lng: 10.7522, codes: ['osl', 'oslo'] },
  { city: 'Bergen', country: 'NO', lat: 60.3913, lng: 5.3221, codes: ['bgo', 'bergen'] },
  { city: 'Stavanger', country: 'NO', lat: 58.97, lng: 5.7331, codes: ['stavanger'] },
  { city: 'Trondheim', country: 'NO', lat: 63.4305, lng: 10.3951, codes: ['trondheim'] },
  { city: 'Helsinki', country: 'FI', lat: 60.1699, lng: 24.9384, codes: ['hel', 'hki', 'hls', 'helsinki'] },
  { city: 'Reykjavík', country: 'IS', lat: 64.1466, lng: -21.9426, codes: ['rkv', 'kef', 'reykjavik'] },
  { city: 'Tallinn', country: 'EE', lat: 59.437, lng: 24.7536, codes: ['tll', 'tallinn'] },
  { city: 'Riga', country: 'LV', lat: 56.9496, lng: 24.1052, codes: ['rix', 'riga'] },
  { city: 'Vilnius', country: 'LT', lat: 54.6872, lng: 25.2797, codes: ['vno', 'vilnius'] },

  // --- Western / Central Europe ---------------------------------------------
  { city: 'Frankfurt', country: 'DE', lat: 50.1109, lng: 8.6821, codes: ['fra', 'ffm', 'frankfurt', 'frnkge'] },
  { city: 'Hamburg', country: 'DE', lat: 53.5511, lng: 9.9937, codes: ['ham', 'hbg', 'hamburg', 'hmbgge'] },
  { city: 'Berlin', country: 'DE', lat: 52.52, lng: 13.405, codes: ['ber', 'txl', 'berlin', 'brlnge'] },
  { city: 'Munich', country: 'DE', lat: 48.1351, lng: 11.582, codes: ['muc', 'munich', 'muenchen', 'mnchge'] },
  { city: 'Düsseldorf', country: 'DE', lat: 51.2277, lng: 6.7735, codes: ['dus', 'dusseldorf', 'duesseldorf', 'dsdfge'] },
  { city: 'Cologne', country: 'DE', lat: 50.9375, lng: 6.9603, codes: ['cgn', 'cologne', 'koeln'] },
  { city: 'Stuttgart', country: 'DE', lat: 48.7758, lng: 9.1829, codes: ['stuttgart', 'sttgge'] },
  { city: 'Nuremberg', country: 'DE', lat: 49.4521, lng: 11.0767, codes: ['nue', 'nuremberg', 'nuernberg'] },
  { city: 'Hanover', country: 'DE', lat: 52.3759, lng: 9.732, codes: ['haj', 'hannover', 'hanover'] },
  { city: 'Leipzig', country: 'DE', lat: 51.3397, lng: 12.3731, codes: ['lej', 'leipzig'] },
  { city: 'Amsterdam', country: 'NL', lat: 52.3676, lng: 4.9041, codes: ['ams', 'adm', 'amsterdam', 'amstnl'] },
  { city: 'Rotterdam', country: 'NL', lat: 51.9244, lng: 4.4777, codes: ['rtm', 'rotterdam'] },
  { city: 'Brussels', country: 'BE', lat: 50.8503, lng: 4.3517, codes: ['bru', 'bxl', 'brussels', 'bruxelles'] },
  { city: 'Luxembourg', country: 'LU', lat: 49.6116, lng: 6.1319, codes: ['lux', 'luxembourg'] },
  { city: 'London', country: 'GB', lat: 51.5074, lng: -0.1278, codes: ['lon', 'ldn', 'lhr', 'lcy', 'london', 'londen'] },
  { city: 'Slough', country: 'GB', lat: 51.5105, lng: -0.595, codes: ['slough'] },
  { city: 'Manchester', country: 'GB', lat: 53.4808, lng: -2.2426, codes: ['mcr', 'manchester'] },
  { city: 'Edinburgh', country: 'GB', lat: 55.9533, lng: -3.1883, codes: ['edi', 'edinburgh'] },
  { city: 'Dublin', country: 'IE', lat: 53.3498, lng: -6.2603, codes: ['dub', 'dublin'] },
  { city: 'Paris', country: 'FR', lat: 48.8566, lng: 2.3522, codes: ['par', 'prs', 'cdg', 'paris', 'parsfr'] },
  { city: 'Marseille', country: 'FR', lat: 43.2965, lng: 5.3698, codes: ['mrs', 'marseille'] },
  { city: 'Lyon', country: 'FR', lat: 45.764, lng: 4.8357, codes: ['lys', 'lyo', 'lyon'] },
  { city: 'Zurich', country: 'CH', lat: 47.3769, lng: 8.5417, codes: ['zrh', 'zur', 'zurich', 'zuerich'] },
  { city: 'Geneva', country: 'CH', lat: 46.2044, lng: 6.1432, codes: ['gva', 'geneva', 'geneve'] },
  { city: 'Vienna', country: 'AT', lat: 48.2082, lng: 16.3738, codes: ['vie', 'wien', 'vienna'] },
  { city: 'Prague', country: 'CZ', lat: 50.0755, lng: 14.4378, codes: ['prg', 'prague', 'praha'] },
  { city: 'Bratislava', country: 'SK', lat: 48.1486, lng: 17.1077, codes: ['bts', 'bratislava'] },
  { city: 'Warsaw', country: 'PL', lat: 52.2297, lng: 21.0122, codes: ['waw', 'warsaw', 'warszawa'] },
  { city: 'Poznań', country: 'PL', lat: 52.4064, lng: 16.9252, codes: ['poz', 'poznan'] },
  { city: 'Budapest', country: 'HU', lat: 47.4979, lng: 19.0402, codes: ['bud', 'budapest'] },
  { city: 'Ljubljana', country: 'SI', lat: 46.0569, lng: 14.5058, codes: ['lju', 'ljubljana'] },
  { city: 'Zagreb', country: 'HR', lat: 45.815, lng: 15.9819, codes: ['zag', 'zagreb'] },
  { city: 'Belgrade', country: 'RS', lat: 44.7866, lng: 20.4489, codes: ['beg', 'belgrade', 'beograd'] },
  { city: 'Bucharest', country: 'RO', lat: 44.4268, lng: 26.1025, codes: ['buh', 'otp', 'bucharest', 'bucuresti'] },
  { city: 'Sofia', country: 'BG', lat: 42.6977, lng: 23.3219, codes: ['sof', 'sofia'] },
  { city: 'Athens', country: 'GR', lat: 37.9838, lng: 23.7275, codes: ['ath', 'athens'] },
  { city: 'Istanbul', country: 'TR', lat: 41.0082, lng: 28.9784, codes: ['ist', 'istanbul'] },
  { city: 'Milan', country: 'IT', lat: 45.4642, lng: 9.19, codes: ['mil', 'mxp', 'milan', 'milano'] },
  { city: 'Rome', country: 'IT', lat: 41.9028, lng: 12.4964, codes: ['rom', 'fco', 'rome', 'roma'] },
  { city: 'Palermo', country: 'IT', lat: 38.1157, lng: 13.3615, codes: ['pmo', 'palermo'] },
  { city: 'Madrid', country: 'ES', lat: 40.4168, lng: -3.7038, codes: ['mad', 'madrid', 'mdrdsp'] },
  { city: 'Barcelona', country: 'ES', lat: 41.3874, lng: 2.1686, codes: ['bcn', 'barcelona'] },
  { city: 'Lisbon', country: 'PT', lat: 38.7223, lng: -9.1393, codes: ['lis', 'lisbon', 'lisboa'] },
  { city: 'Kyiv', country: 'UA', lat: 50.4501, lng: 30.5234, codes: ['iev', 'kbp', 'kiev', 'kyiv'] },
  { city: 'Moscow', country: 'RU', lat: 55.7558, lng: 37.6173, codes: ['mow', 'svo', 'dme', 'msk', 'moscow'] },

  // --- Middle East / Africa --------------------------------------------------
  { city: 'Dubai', country: 'AE', lat: 25.2048, lng: 55.2708, codes: ['dxb', 'dubai'] },
  { city: 'Fujairah', country: 'AE', lat: 25.1288, lng: 56.3265, codes: ['fjr', 'fujairah'] },
  { city: 'Tel Aviv', country: 'IL', lat: 32.0853, lng: 34.7818, codes: ['tlv', 'telaviv'] },
  { city: 'Cairo', country: 'EG', lat: 30.0444, lng: 31.2357, codes: ['cai', 'cairo'] },
  { city: 'Johannesburg', country: 'ZA', lat: -26.2041, lng: 28.0473, codes: ['jnb', 'johannesburg'] },
  { city: 'Cape Town', country: 'ZA', lat: -33.9249, lng: 18.4241, codes: ['cpt', 'capetown'] },
  { city: 'Nairobi', country: 'KE', lat: -1.2921, lng: 36.8219, codes: ['nbo', 'nairobi'] },
  { city: 'Lagos', country: 'NG', lat: 6.5244, lng: 3.3792, codes: ['lagos'] },

  // --- Asia / Oceania --------------------------------------------------------
  { city: 'Singapore', country: 'SG', lat: 1.3521, lng: 103.8198, codes: ['sin', 'sgp', 'singapore'] },
  { city: 'Hong Kong', country: 'HK', lat: 22.3193, lng: 114.1694, codes: ['hkg', 'hongkong'] },
  { city: 'Tokyo', country: 'JP', lat: 35.6762, lng: 139.6503, codes: ['tyo', 'nrt', 'hnd', 'tok', 'tokyo', 'tokyjp'] },
  { city: 'Osaka', country: 'JP', lat: 34.6937, lng: 135.5023, codes: ['osa', 'kix', 'osaka'] },
  { city: 'Seoul', country: 'KR', lat: 37.5665, lng: 126.978, codes: ['sel', 'icn', 'seoul'] },
  { city: 'Taipei', country: 'TW', lat: 25.033, lng: 121.5654, codes: ['tpe', 'taipei'] },
  { city: 'Mumbai', country: 'IN', lat: 19.076, lng: 72.8777, codes: ['bom', 'mumbai'] },
  { city: 'Chennai', country: 'IN', lat: 13.0827, lng: 80.2707, codes: ['maa', 'chennai'] },
  { city: 'Delhi', country: 'IN', lat: 28.7041, lng: 77.1025, codes: ['delhi', 'newdelhi'] },
  { city: 'Bangkok', country: 'TH', lat: 13.7563, lng: 100.5018, codes: ['bkk', 'bangkok'] },
  { city: 'Kuala Lumpur', country: 'MY', lat: 3.139, lng: 101.6869, codes: ['kul', 'kualalumpur'] },
  { city: 'Jakarta', country: 'ID', lat: -6.2088, lng: 106.8456, codes: ['cgk', 'jkt', 'jakarta'] },
  { city: 'Manila', country: 'PH', lat: 14.5995, lng: 120.9842, codes: ['mnl', 'manila'] },
  { city: 'Sydney', country: 'AU', lat: -33.8688, lng: 151.2093, codes: ['syd', 'sydney'] },
  { city: 'Melbourne', country: 'AU', lat: -37.8136, lng: 144.9631, codes: ['mel', 'melbourne'] },
  { city: 'Perth', country: 'AU', lat: -31.9505, lng: 115.8605, codes: ['perth'] },
  { city: 'Auckland', country: 'NZ', lat: -36.8485, lng: 174.7633, codes: ['akl', 'auckland'] },

  // --- Americas --------------------------------------------------------------
  { city: 'New York', country: 'US', lat: 40.7128, lng: -74.006, codes: ['nyc', 'nyk', 'jfk', 'lga', 'newyork', 'nwyrny'] },
  { city: 'Newark', country: 'US', lat: 40.7357, lng: -74.1724, codes: ['ewr', 'newark'] },
  { city: 'Ashburn', country: 'US', lat: 39.0438, lng: -77.4874, codes: ['ash', 'iad', 'ashburn', 'asbnva'] },
  { city: 'Washington', country: 'US', lat: 38.9072, lng: -77.0369, codes: ['dca', 'wdc', 'washington', 'wshndc'] },
  { city: 'Boston', country: 'US', lat: 42.3601, lng: -71.0589, codes: ['bos', 'boston'] },
  { city: 'Chicago', country: 'US', lat: 41.8781, lng: -87.6298, codes: ['chi', 'ord', 'chicago', 'chcgil'] },
  { city: 'Atlanta', country: 'US', lat: 33.749, lng: -84.388, codes: ['atl', 'atlanta', 'atlnga'] },
  { city: 'Miami', country: 'US', lat: 25.7617, lng: -80.1918, codes: ['mia', 'miami', 'miamfl'] },
  { city: 'Dallas', country: 'US', lat: 32.7767, lng: -96.797, codes: ['dal', 'dfw', 'dallas', 'dllstx'] },
  { city: 'Houston', country: 'US', lat: 29.7604, lng: -95.3698, codes: ['hou', 'iah', 'houston'] },
  { city: 'Kansas City', country: 'US', lat: 39.0997, lng: -94.5786, codes: ['mci', 'kansascity'] },
  { city: 'Minneapolis', country: 'US', lat: 44.9778, lng: -93.265, codes: ['msp', 'minneapolis'] },
  { city: 'Denver', country: 'US', lat: 39.7392, lng: -104.9903, codes: ['den', 'denver'] },
  { city: 'Phoenix', country: 'US', lat: 33.4484, lng: -112.074, codes: ['phx', 'phoenix'] },
  { city: 'Salt Lake City', country: 'US', lat: 40.7608, lng: -111.891, codes: ['slc', 'saltlake'] },
  { city: 'Las Vegas', country: 'US', lat: 36.1699, lng: -115.1398, codes: ['lasvegas'] },
  { city: 'Los Angeles', country: 'US', lat: 34.0522, lng: -118.2437, codes: ['lax', 'losangeles', 'lsanca'] },
  { city: 'San Jose', country: 'US', lat: 37.3382, lng: -121.8863, codes: ['sjc', 'sanjose', 'snjsca'] },
  { city: 'Palo Alto', country: 'US', lat: 37.4419, lng: -122.143, codes: ['pao', 'paloalto'] },
  { city: 'San Francisco', country: 'US', lat: 37.7749, lng: -122.4194, codes: ['sfo', 'sanfrancisco'] },
  { city: 'Seattle', country: 'US', lat: 47.6062, lng: -122.3321, codes: ['sea', 'seattle', 'sttlwa'] },
  { city: 'Toronto', country: 'CA', lat: 43.6532, lng: -79.3832, codes: ['yyz', 'toronto'] },
  { city: 'Montreal', country: 'CA', lat: 45.5017, lng: -73.5673, codes: ['yul', 'ymq', 'montreal'] },
  { city: 'Vancouver', country: 'CA', lat: 49.2827, lng: -123.1207, codes: ['yvr', 'vancouver'] },
  { city: 'Mexico City', country: 'MX', lat: 19.4326, lng: -99.1332, codes: ['mex', 'mexico'] },
  { city: 'São Paulo', country: 'BR', lat: -23.5505, lng: -46.6333, codes: ['sao', 'gru', 'saopaulo'] },
  { city: 'Rio de Janeiro', country: 'BR', lat: -22.9068, lng: -43.1729, codes: ['gig', 'rio'] },
  { city: 'Buenos Aires', country: 'AR', lat: -34.6037, lng: -58.3816, codes: ['eze', 'bue', 'buenosaires'] },
  { city: 'Santiago', country: 'CL', lat: -33.4489, lng: -70.6693, codes: ['scl', 'santiago'] },
  { city: 'Bogotá', country: 'CO', lat: 4.711, lng: -74.0721, codes: ['bog', 'bogota'] },
  { city: 'Lima', country: 'PE', lat: -12.0464, lng: -77.0428, codes: ['lim', 'lima'] },
];

module.exports = { PLACES };
