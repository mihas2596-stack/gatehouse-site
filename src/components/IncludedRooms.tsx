import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

type Room = { room: string; tasks: string[] };

/** Renders the room checklist once: columns on tablet+, accordion on phones. */
const IncludedRooms = ({ rooms }: { rooms: Room[] }) => {
  const [isPhone, setIsPhone] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 639px)");
    const update = () => setIsPhone(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  if (isPhone) {
    return (
      <>
        <p className="mb-3 text-left text-sm leading-relaxed text-muted-foreground">
          Every standard clean includes all of this — tap a room to see the checklist.
        </p>
        <Accordion type="single" collapsible className="rounded-lg border border-border bg-card px-4">
          {rooms.map(({ room, tasks }) => (
            <AccordionItem key={room} value={room}>
              <AccordionTrigger className="text-left font-heading text-base font-semibold text-sage-foreground hover:no-underline">
                {room}
              </AccordionTrigger>
              <AccordionContent>
                <ul className="space-y-2 pb-1">
                  {tasks.map((task) => (
                    <li key={task} className="flex items-start gap-2 text-sm leading-relaxed text-foreground">
                      <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                      <span>{task}</span>
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-6 text-left">
      {rooms.map(({ room, tasks }) => (
        <div key={room}>
          <h3 className="mb-3 font-heading text-lg font-semibold text-sage-foreground md:text-xl">{room}</h3>
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
  );
};

export default IncludedRooms;
