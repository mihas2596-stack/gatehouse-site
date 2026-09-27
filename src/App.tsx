import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Layout from "./components/Layout";
import ScrollToTop from "./components/ScrollToTop";
import Index from "./pages/Index";

const Services = lazy(() => import("./pages/Services"));
const About = lazy(() => import("./pages/About"));
const Reviews = lazy(() => import("./pages/Reviews"));
const Areas = lazy(() => import("./pages/Areas"));
const Contact = lazy(() => import("./pages/Contact"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Quote = lazy(() => import("./pages/Quote"));
const WhatsIncluded = lazy(() => import("./pages/WhatsIncluded"));
const FAQ = lazy(() => import("./pages/FAQ"));
const CityPage = lazy(() => import("./pages/CityPage"));
const Privacy = lazy(() => import("./pages/Privacy"));
const Terms = lazy(() => import("./pages/Terms"));
const ThankYou = lazy(() => import("./pages/ThankYou"));

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <ScrollToTop />
        <Suspense fallback={<div className="min-h-screen" />}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Index />} />
            <Route path="/services" element={<Services />} />
            <Route path="/services/standard-cleaning" element={<Navigate to="/services" replace />} />
            <Route path="/services/deep-cleaning" element={<Navigate to="/services" replace />} />
            <Route path="/services/move-in-out-cleaning" element={<Navigate to="/services" replace />} />
            <Route path="/services/recurring-plans" element={<Navigate to="/services" replace />} />
            <Route path="/quote" element={<Quote />} />
            <Route path="/whats-included" element={<WhatsIncluded />} />
            <Route path="/faq" element={<FAQ />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/thank-you" element={<ThankYou />} />
            <Route path="/availability" element={<Navigate to="/quote" replace />} />
            <Route path="/about" element={<About />} />
            <Route path="/founding" element={<Reviews />} />
            <Route path="/reviews" element={<Navigate to="/quote" replace />} />
            <Route path="/gallery" element={<Navigate to="/quote" replace />} />
            <Route path="/areas" element={<Areas />} />
            <Route path="/areas/:city" element={<CityPage />} />
            <Route path="/contact" element={<Contact />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
