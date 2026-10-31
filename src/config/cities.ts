export type CitySection = { heading: string; text: string };
export type City = {
  slug: string;
  name: string;
  title: string;
  description: string;
  sections: CitySection[];
};

export const CITIES: City[] = [
  {
    slug: "sugar-hill",
    name: "Sugar Hill",
    title: "House Cleaning in Sugar Hill, GA | Gatehouse Home Cleaning",
    description: "Every-other-week house cleaning in Sugar Hill, GA. Your price is based on the details you enter; your regular day and arrival window repeat every other week.",
    sections: [
      { heading: "Homes in Sugar Hill", text: "Sugar Hill sits at the northern edge of Gwinnett County." },
      { heading: "What a visit covers", text: "A Gatehouse visit in Sugar Hill follows the same checklist every time: kitchen surfaces and appliance exteriors, bathrooms top to bottom, dusting of reachable surfaces in bedrooms and living areas, then vacuuming and mopping throughout. You pick a weekday and an arrival window when you book; we keep that day and window for your recurring visits and agree any change with you in advance." },
      { heading: "Price and booking", text: "Pricing is published, not quoted over the phone. Enter your home size, bedrooms and bathrooms and you will see your every-other-week price for Sugar Hill, before you give us any contact details. Add-on prices, such as inside the oven or inside the fridge, are shown before you book. There is no long-term commitment and no membership fee — pause or stop the schedule whenever you need to." },
    ],
  },
  {
    slug: "suwanee",
    name: "Suwanee",
    title: "House Cleaning in Suwanee, GA | Gatehouse Home Cleaning",
    description: "Every-other-week house cleaning in Suwanee, GA. Your price is based on the details you enter; your regular day and arrival window repeat every other week.",
    sections: [
      { heading: "Homes in Suwanee", text: "Suwanee is a suburb built around Town Center, with neighborhoods spreading east toward Lawrenceville-Suwanee Road. The calculator asks for an approximate home size to plan the visit; the price is based on bedrooms and full bathrooms." },
      { heading: "What a visit covers", text: "Every visit covers the same rooms in the same order: kitchen, bathrooms, bedrooms, then living areas and hallways. Stair railings get wiped, stairs get vacuumed, beds are made and trash is emptied. We bring our own vacuum, mop, cloths and products, so nothing needs to be waiting for us in the laundry room." },
      { heading: "Scheduling and payment", text: "Most homes get a price online; larger homes can email us for a custom quote. You see your every-other-week price on screen, request a day and arrival window, and we confirm within one business day. Nothing is charged at booking. Your card is charged after the visit, when you approve the photo report — or automatically 24 hours after we send the report if you haven't reported an issue. Cancel or reschedule free up to 48 hours before a visit." },
    ],
  },
  {
    slug: "buford",
    name: "Buford",
    title: "House Cleaning in Buford, GA | Gatehouse Home Cleaning",
    description: "Every-other-week house cleaning in Buford, GA. Your price is based on the details you enter; your regular day and arrival window repeat every other week.",
    sections: [
      { heading: "Homes in Buford", text: "Buford spans parts of Gwinnett and Hall counties and mixes long-established streets near the historic downtown with newer construction further north. Home styles vary widely here, from compact ranch houses to large builds with multiple living areas, so the calculator price is based on bedrooms, full bathrooms and your cleaning selections." },
      { heading: "How the every-other-week rhythm works", text: "The every-other-week rhythm suits Buford households that want a clean house on a set weekday. Because the house never accumulates weeks of dust and soap scum, each visit takes less time than a one-off clean, and that lower effort is reflected in a lower price per visit." },
      { heading: "First visit: standard or deep", text: "If a professional cleaned your Buford home in the last 3 months, your first visit is a standard clean. If not, your first visit is a deep clean. The calculator shows both prices before you book, so you see the first visit and the ongoing every-other-week rate side by side." },
    ],
  },
  {
    slug: "duluth",
    name: "Duluth",
    title: "House Cleaning in Duluth, GA | Gatehouse Home Cleaning",
    description: "Every-other-week house cleaning in Duluth, GA. Your price is based on the details you enter; your regular day and arrival window repeat every other week.",
    sections: [
      { heading: "Homes in Duluth", text: "Duluth is one of the denser parts of our service area, with townhomes and condominiums near Sugarloaf Parkway alongside traditional single-family streets closer to the downtown green. Townhome layouts stack bathrooms and bedrooms over two or three floors, so our checklist includes stair railings, stairs and hallway floors on every visit." },
      { heading: "Price", text: "Pricing works the same way here as everywhere else we serve: bedrooms, full bathrooms, cleaning type, frequency and add-ons. We collect an approximate home size and half bathrooms for scheduling; they do not change the calculator price." },
      { heading: "Access and payment", text: "If your building has controlled access or a gate, you add gate details privately on your confirmed visit page — never in open booking notes. You do not need to be home during the visit. Your card is charged after the visit, when you approve the photo report — or automatically 24 hours after we send the report if you haven't reported an issue — and your weekday and arrival window repeat every other week unless we agree a change with you." },
    ],
  },
  {
    slug: "johns-creek",
    name: "Johns Creek",
    title: "House Cleaning in Johns Creek, GA | Gatehouse Home Cleaning",
    description: "Every-other-week house cleaning in Johns Creek, GA. Your price is based on the details you enter; your regular day and arrival window repeat every other week.",
    sections: [
      { heading: "Homes in Johns Creek", text: "Johns Creek sits in north Fulton County. The calculator asks for a size band to plan the visit. The displayed price is based on bedrooms, full bathrooms and your cleaning selections." },
      { heading: "What a visit covers", text: "Each visit follows the published room-by-room checklist: countertops, sinks and appliance exteriors in the kitchen; toilets, tubs, showers, mirrors and floors in every bathroom; dusting and floors in bedrooms and living areas. Extras beyond the checklist — inside the oven, inside the fridge, interior windows, inside cabinets, extra pet-hair work — are optional add-ons with fixed prices." },
      { heading: "Scheduling and payment", text: "Scheduling in Johns Creek is deliberately simple. You choose the day and arrival window that works, and we keep that day and window for your recurring visits and agree any change with you in advance. There is no membership fee, no promo code and no long-term commitment. Your card is charged after the visit, when you approve the photo report — or automatically 24 hours after we send the report if you haven't reported an issue." },
    ],
  },
  {
    slug: "alpharetta",
    name: "Alpharetta",
    title: "House Cleaning in Alpharetta, GA | Gatehouse Home Cleaning",
    description: "Every-other-week house cleaning in Alpharetta, GA. Your price is based on the details you enter; your regular day and arrival window repeat every other week.",
    sections: [
      { heading: "Homes in Alpharetta", text: "Alpharetta is part of our North Atlanta service area, with a mix of new mixed-use developments near Avalon and established residential streets spreading out toward Windward. Houses here range from compact townhomes to large family homes, and both fit the same simple pricing model: bedrooms, full bathrooms, cleaning type, frequency and add-ons." },
      { heading: "What a visit covers", text: "The service itself is a standard clean repeated on a fixed rhythm. Kitchens and bathrooms get the detailed work, bedrooms and living areas get dusting and floors, and trash is emptied throughout. We arrive with our own supplies and equipment, so nothing needs to be supplied by you." },
      { heading: "Price and booking", text: "Because we publish prices, there is no quote call and no in-home estimate visit in Alpharetta. Enter the details of the home, read the number on screen, then request the day and arrival window you want. We confirm within one business day. Your card is charged after the visit, when you approve the photo report — or automatically 24 hours after we send the report if you haven't reported an issue." },
    ],
  },
  {
    slug: "roswell",
    name: "Roswell",
    title: "House Cleaning in Roswell, GA | Gatehouse Home Cleaning",
    description: "Every-other-week house cleaning in Roswell, GA. See your price online and request your regular day and arrival window.",
    sections: [
      { heading: "Homes in Roswell", text: "Roswell homes come in many shapes, from townhomes near the historic district to single-family homes across the neighborhoods around Holcomb Bridge Road. Gatehouse Home Cleaning offers a room-by-room standard clean every other week, with a day and arrival window you can keep on your schedule. Enter your bedrooms and bathrooms in the calculator to see the visit price before you share your contact details. For larger homes, email us for a custom quote." },
      { heading: "What a visit covers", text: "A standard visit covers kitchen counters, sinks and appliance exteriors; bathroom fixtures, mirrors and floors; and dusting, vacuuming and mopping in bedrooms and living areas. You can check the full room-by-room list before requesting a booking. Inside the oven, inside the fridge, inside cabinets and interior windows are available as add-ons, with their prices shown in the calculator. We bring the supplies and equipment needed for the clean." },
      { heading: "Booking and payment", text: "When requesting a Roswell visit, share your ZIP, street address, preferred date and arrival window. We confirm requests within one business day. If a professional cleaner has cleaned your home in the past three months, the first visit is a standard clean. Otherwise, the first visit starts with a deep clean; the calculator shows the first-visit and every-other-week prices. After the clean, you receive a photo report and your card is charged when you approve it — or automatically 24 hours after we send the report if you haven't reported an issue." },
    ],
  },
];

export const CITY_BY_SLUG: Record<string, City> = Object.fromEntries(CITIES.map((c) => [c.slug, c]));
