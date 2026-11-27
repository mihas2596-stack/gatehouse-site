import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export default function ChooseNewVisitDate({ bookingToken }: { bookingToken: string }) {
  const dateOptionsLink = `/visit?bt=${encodeURIComponent(bookingToken)}#choose-date`;
  return (
    <div className="text-center">
      <h1 className="font-heading text-3xl font-bold mb-4">Your requested date isn&apos;t available</h1>
      <p className="text-lg mb-6">Card saved. $0 charged today.</p>
      <Button asChild variant="hero" size="lg" className="w-full">
        <Link reloadDocument to={dateOptionsLink}>Choose a new date</Link>
      </Button>
    </div>
  );
}
