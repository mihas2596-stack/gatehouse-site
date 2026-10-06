import { Link } from "react-router-dom";
import { Mail, MapPin } from "lucide-react";

const cities = ["Sugar Hill", "Suwanee", "Buford", "Duluth", "Johns Creek", "Alpharetta", "Roswell"];

const Footer = () => {
  return (
    <footer className="bg-secondary text-[#3D2B1F]">
      <div className="container pt-8 pb-10 md:py-14">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:gap-12">
          <div>
            <span className="font-script text-3xl text-[#6B3A1F] font-bold block leading-none">
              Gatehouse Home Cleaning
            </span>
            <span
              className="block font-semibold uppercase mt-1 mb-2"
              style={{ color: '#6B3A1F', fontSize: '10px', letterSpacing: '0.18em' }}
            >
              North Atlanta, GA
            </span>
            <p className="mt-4 text-[#3D2B1F] text-sm leading-relaxed">
              Every-other-week house cleaning. Same day, same time. Price estimate online.
            </p>
          </div>

          <div className="flex flex-col gap-3 text-sm md:items-start">
            <a href="mailto:hello@gatehousehomecleaning.com" className="flex min-h-[44px] items-center gap-2 text-[#3D2B1F] hover:text-[#5C3D2E] transition-colors font-medium break-all md:min-h-0">
              <Mail className="w-4 h-4 text-[#3D2B1F]" />
              hello@gatehousehomecleaning.com
            </a>
            <div className="flex items-start gap-2 text-[#3D2B1F] font-medium">
              <MapPin className="w-4 h-4 text-[#3D2B1F] mt-0.5 shrink-0" />
              <span>{cities.join(" · ")}</span>
            </div>
          </div>
        </div>

        <div className="border-t border-[#3D2B1F]/20 mt-8 pt-6 md:mt-10 md:pt-6 flex flex-col md:flex-row items-center justify-between gap-3">
          <p className="text-[#3D2B1F]/75 text-sm">
            &copy; {new Date().getFullYear()} Gatehouse Home Cleaning. All rights reserved.
          </p>
          <nav aria-label="Footer navigation" className="flex flex-wrap justify-center items-center gap-x-4 gap-y-1">
            <Link to="/about" className="inline-flex min-h-[44px] items-center text-sm">About Nick</Link>
            <Link to="/contact" className="inline-flex min-h-[44px] items-center text-sm">Contact</Link>
            <Link to="/founding" className="inline-flex min-h-[44px] items-center text-sm">Founding Clients</Link>
            <Link to="/whats-included" className="inline-flex min-h-[44px] items-center px-1 text-[#3D2B1F]/75 hover:text-[#5C3D2E] text-sm transition-colors md:min-h-0 md:px-0">
              What's Included
            </Link>
            <Link to="/faq" className="inline-flex min-h-[44px] items-center px-1 text-[#3D2B1F]/75 hover:text-[#5C3D2E] text-sm transition-colors md:min-h-0 md:px-0">
              FAQ
            </Link>
            <Link to="/privacy" className="inline-flex min-h-[44px] items-center px-1 text-[#3D2B1F]/75 hover:text-[#5C3D2E] text-sm transition-colors md:min-h-0 md:px-0">
              Privacy Policy
            </Link>
            <Link to="/terms" className="inline-flex min-h-[44px] items-center px-1 text-[#3D2B1F]/75 hover:text-[#5C3D2E] text-sm transition-colors md:min-h-0 md:px-0">
              Terms of Service
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
