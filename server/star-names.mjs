// Real, IAU-recognized proper star names - the random-naming pool for new
// personas (symposion "come up with a random name instead of requiring
// one"). Deliberately actual stars (Sirius, Vega, Betelgeuse, ...), not
// constellations or made-up sci-fi names, per Brian's ask for "known star
// names in the galaxy." Deduplicated (case-insensitive) - randomStarName's
// collision handling below assumes every entry here is otherwise distinct.
const STAR_NAMES = [
  "Sirius", "Canopus", "Rigil Kentaurus", "Arcturus",
  "Vega", "Capella", "Rigel", "Procyon",
  "Achernar", "Betelgeuse", "Hadar", "Altair",
  "Acrux", "Aldebaran", "Antares", "Spica",
  "Pollux", "Fomalhaut", "Deneb", "Mimosa",
  "Regulus", "Adhara", "Castor", "Gacrux",
  "Shaula", "Bellatrix", "Elnath", "Miaplacidus",
  "Alnilam", "Alnair", "Alnitak", "Alioth",
  "Dubhe", "Mirfak", "Wezen", "Sargas",
  "Kaus Australis", "Avior", "Alkaid", "Menkalinan",
  "Atria", "Alhena", "Peacock", "Alsephina",
  "Mirzam", "Polaris", "Alphard", "Algieba",
  "Hamal", "Diphda", "Nunki", "Menkent",
  "Mirach", "Alpheratz", "Rasalhague", "Kochab",
  "Saiph", "Denebola", "Algol", "Muhlifain",
  "Naos", "Aspidiske", "Alphecca", "Suhail",
  "Sadr", "Eltanin", "Schedar", "Mintaka",
  "Caph", "Dschubba", "Larawag", "Merak",
  "Ankaa", "Girtab", "Enif", "Scheat",
  "Sabik", "Phecda", "Aludra", "Markeb",
  "Aljanah", "Acrab", "Zosma", "Gienah",
  "Alderamin", "Vindemiatrix", "Zubenelgenubi", "Rasalgethi",
  "Nihal", "Kaus Media", "Kaus Borealis", "Kraz",
  "Yildun", "Muscida", "Mahasim", "Sadalsuud",
  "Sadalmelik", "Tarazed", "Alnasl", "Fawaris",
  "Sadachbia", "Skat", "Situla", "Ancha",
  "Homam", "Matar", "Biham", "Algedi",
  "Dabih", "Nashira", "Deneb Algedi", "Alshat",
  "Kitalpha", "Alrescha", "Torcular", "Angetenar",
  "Cursa", "Zaurak", "Rana", "Beid",
  "Keid", "Azha", "Zibal", "Sceptrum",
  "Menkib", "Atik", "Miram", "Capulus",
  "Alterf", "Subra", "Chertan", "Zavijava",
  "Porrima", "Auva", "Heze", "Kang",
  "Alkes", "Alphekka", "Unukalhai", "Cebalrai",
  "Marfik", "Yed Prior", "Yed Posterior", "Sinistra",
  "Albaldah", "Ascella", "Albireo", "Sadalbari",
  "Rotanev", "Sualocin", "Furud", "Wazn",
  "Alsuhail", "Regor", "Turais", "Zubeneschamali",
  "Zubenelhakrabi", "Graffias", "Iklil", "Alniyat",
  "Al Nasl", "Meissa", "Hatysa", "Tabit",
  "Wasat", "Mebsuta", "Mekbuda", "Propus",
  "Tejat", "Alzirr", "Muliphein", "Sirrah",
  "Almach", "Titawin", "Rukbat", "Arkab",
  "Baham", "Errai", "Alfirk", "Chow",
  "Kurhah", "Piautos", "Alya", "Rukh",
  "Ain", "Prima Hyadum", "Secunda Hyadum", "Aldhibah",
  "Rastaban", "Alwaid", "Alkurah", "Grumium",
  "Edasich", "Athebyne", "Kajam", "Marsic",
  "Maasym", "Ras Algethi", "Sarin", "Sheliak",
  "Sulafat", "Aladfar", "Anser", "Almaaz",
];

/**
 * Picks a random star name not already in use by a live persona (case-
 * insensitive). If the whole pool is already taken (unlikely at any normal
 * persona count), falls back to a numbered variant of a random pick rather
 * than looping forever or handing back a silent duplicate.
 */
export function randomStarName(excluding = []) {
  const used = new Set(excluding.map((n) => n.trim().toLowerCase()));
  const available = STAR_NAMES.filter((n) => !used.has(n.toLowerCase()));
  if (available.length > 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  const base = STAR_NAMES[Math.floor(Math.random() * STAR_NAMES.length)];
  let n = 2;
  while (used.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}
