export type CitySection = { heading: string; text: string; link?: { href: string; label: string } };
export type City = {
  slug: string;
  name: string;
  title: string;
  description: string;
  sections: CitySection[];
};

// MB-15 / B8: every city gets its own title and description (no
// templated duplicates), and one accent everywhere — "One-time and
// every-other-week visits". LB-32: only the "Homes in …" section is
// rendered (CityPage filters on it), so the other sections — with
// their stale text — are gone, not kept around to be published by
// accident. Each "Homes in …" section is 2–3 sentences about the
// city and its home types.
export const CITIES: City[] = [
  {
    slug: "sugar-hill",
    name: "Sugar Hill",
    title: "House Cleaning in Sugar Hill, GA — One-Time and Every-Other-Week Visits | Gatehouse Home Cleaning",
    description: "One-time and every-other-week house cleaning in Sugar Hill, GA. See your price online, then request a date. We confirm each visit with you — single-family homes, two-story houses and townhomes.",
    sections: [
      { heading: "Homes in Sugar Hill", text: "Sugar Hill sits at the northern edge of Gwinnett County. Most homes here are single-family houses, many with two stories, several bedrooms and bathrooms, and open living areas — so the price follows bedrooms and full bathrooms, and a larger home costs more than a smaller one. You pick a weekday and an arrival window when you book, and we arrange and confirm each visit with you." },
    ],
  },
  {
    slug: "suwanee",
    name: "Suwanee",
    title: "House Cleaning in Suwanee, GA — One-Time, Deep & Every-Other-Week Cleans | Gatehouse Home Cleaning",
    description: "One-time and every-other-week house cleaning in Suwanee, GA. See your price online, then request a date. Town Center neighborhoods and the streets toward Lawrenceville-Suwanee Road — we confirm each visit with you.",
    sections: [
      { heading: "Homes in Suwanee", text: "Suwanee is a suburb built around Town Center, with neighborhoods spreading east toward Lawrenceville-Suwanee Road. Homes here mix single-family houses with townhomes, many with two or three floors, so stairs, railings and hallway floors are part of every visit. Choose a weekday and arrival window when you book; we arrange and confirm each recurring visit with you." },
    ],
  },
  {
    slug: "buford",
    name: "Buford",
    title: "House Cleaning in Buford, GA — One-Time and Every-Other-Week Cleans for Ranch & Newer Homes | Gatehouse Home Cleaning",
    description: "One-time and every-other-week house cleaning in Buford, GA. See your price online, then request a date. Compact ranch houses and large newer builds — priced by bedrooms and bathrooms, confirmed with you.",
    sections: [
      { heading: "Homes in Buford", text: "Buford spans parts of Gwinnett and Hall counties and mixes long-established streets near the historic downtown with newer construction further north. Home styles vary widely here, from compact ranch houses to large builds with multiple living areas, so your price is based on bedrooms, full bathrooms and your cleaning selections. Because sizes vary so much, the price follows the home itself — not the street you live on." },
    ],
  },
  {
    slug: "duluth",
    name: "Duluth",
    title: "House Cleaning in Duluth, GA — One-Time and Every-Other-Week Cleans for Townhomes & Houses | Gatehouse Home Cleaning",
    description: "One-time and every-other-week house cleaning in Duluth, GA. See your price online, then request a date. Townhomes near Sugarloaf Parkway and single-family streets near the downtown green — we confirm each visit with you.",
    sections: [
      { heading: "Homes in Duluth", text: "Duluth is one of the denser parts of our service area, with townhomes and condominiums near Sugarloaf Parkway alongside traditional single-family streets closer to the downtown green. Townhome layouts stack bathrooms and bedrooms over two or three floors, so our checklist includes stair railings, stairs and hallway floors on every visit. Most visits here are every other week, on a weekday and arrival window you choose — and we confirm each visit with you." },
    ],
  },
  {
    slug: "johns-creek",
    name: "Johns Creek",
    title: "House Cleaning in Johns Creek, GA — One-Time and Every-Other-Week Cleans in North Fulton | Gatehouse Home Cleaning",
    description: "One-time and every-other-week house cleaning in Johns Creek, GA. See your price online, then request a date. Single-family homes across north Fulton County — we confirm each visit with you.",
    sections: [
      { heading: "Homes in Johns Creek", text: "Johns Creek sits in north Fulton County. Most homes are single-family houses on quiet residential streets, often with several bedrooms and bathrooms and large living areas. Your price is set by bedrooms and full bathrooms, and we confirm the day and arrival window of each visit with you." },
    ],
  },
  {
    slug: "alpharetta",
    name: "Alpharetta",
    title: "House Cleaning in Alpharetta, GA — One-Time and Every-Other-Week Cleans, Avalon to Windward | Gatehouse Home Cleaning",
    description: "One-time and every-other-week house cleaning in Alpharetta, GA. See your price online, then request a date. Townhomes near Avalon and family homes toward Windward — we confirm each visit with you.",
    sections: [
      { heading: "Homes in Alpharetta", text: "Alpharetta is part of our North Atlanta service area, with a mix of new mixed-use developments near Avalon and established residential streets spreading out toward Windward. Houses here range from compact townhomes to large family homes, and both fit the same simple pricing model: bedrooms, full bathrooms, cleaning type, frequency and add-ons. We clean townhomes and large family homes alike, on a weekday and arrival window you choose — and each visit is arranged and confirmed with you." },
    ],
  },
  {
    slug: "roswell",
    name: "Roswell",
    title: "House Cleaning in Roswell, GA — One-Time and Every-Other-Week Cleans in Historic Roswell | Gatehouse Home Cleaning",
    description: "One-time and every-other-week house cleaning in Roswell, GA. See your price online and request a date and arrival window. Townhomes near the historic district and family homes around Holcomb Bridge Road — we confirm each visit with you.",
    sections: [
      { heading: "Homes in Roswell", text: "Roswell homes come in many shapes, from townhomes near the historic district to single-family homes across the neighborhoods around Holcomb Bridge Road. Gatehouse Home Cleaning offers a room-by-room standard clean every other week, with each day and arrival window confirmed with you. Enter your bedrooms and bathrooms in the quote to see the visit price before you share your contact details — for homes with 6+ bedrooms or 6+ full bathrooms, email us for a custom quote." },
    ],
  },
];

export const CITY_BY_SLUG: Record<string, City> = Object.fromEntries(CITIES.map((c) => [c.slug, c]));
