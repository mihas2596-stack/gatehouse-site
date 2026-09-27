import { CheckCircle2, X } from "lucide-react";
import { Link } from "react-router-dom";
import SEO from "@/components/SEO";
import { Button } from "@/components/ui/button";
import { CHECKLIST, NOT_INCLUDED } from "@/config/checklist";
import { ADDONS } from "@/config/calculator";

const addons = [
  ADDONS.insideOven,
  ADDONS.insideFridge,
  ADDONS.interiorWindow,
  { label: "Inside cabinets", price: 45 },
];

const WhatsIncluded = () => (
  <div className="pt-24">
    <SEO
      title="What's Included in a House Cleaning | Gatehouse"
      description="Room-by-room task list for every visit, the add-ons you can pick, and what we do not do."
      url="https://gatehousehomecleaning.com/whats-included"
    />

    <section className="bg-warm-gradient py-12 md:py-16">
      <div className="container max-w-3xl text-center">
        <p className="font-script text-xl text-golden mb-2">The full list</p>
        <h1 className="font-heading text-3xl md:text-[44px] font-bold mb-3">
          What's Included in Every Visit
        </h1>
        <p className="text-foreground text-lg">
          Everything in the room lists below is included in every visit. Add-ons are listed separately with their prices.
        </p>
      </div>
    </section>

    <section className="py-12 md:py-16">
      <div className="container max-w-5xl">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
          {CHECKLIST.map(({ room, tasks }) => (
            <div key={room} className="rounded-2xl bg-card p-6 shadow-warm">
              <h2 className="mb-4 font-heading text-xl font-bold text-sage-foreground">{room}</h2>
              <ul className="space-y-2">
                {tasks.map((task) => (
                  <li key={task} className="flex items-start gap-2 text-sm leading-relaxed text-foreground md:text-base">
                    <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                    <span>{task}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-2">
          <div className="rounded-2xl bg-card p-6 shadow-warm">
            <h2 className="mb-4 font-heading text-xl font-bold text-sage-foreground">Add-ons (fixed price)</h2>
            <ul className="space-y-2">
              {addons.map(({ label, price }) => (
                <li key={label} className="flex items-center justify-between gap-4 text-sm text-foreground md:text-base">
                  <span>{label}</span>
                  <span className="font-semibold text-primary">+${price}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl bg-card p-6 shadow-warm">
            <h2 className="mb-4 font-heading text-xl font-bold text-sage-foreground">Not included</h2>
            <ul className="space-y-2">
              {NOT_INCLUDED.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-foreground md:text-base">
                  <X className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-10 text-center">
          <Button asChild variant="hero" size="lg" className="rounded-full px-8">
            <Link to="/quote">See My Exact Price</Link>
          </Button>
        </div>
      </div>
    </section>
  </div>
);

export default WhatsIncluded;
