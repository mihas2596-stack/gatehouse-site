import { trackFunnel } from "@/lib/measurement";
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export default function ScrollToTop() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (hash) {
      const id = hash.slice(1);
      // Wait a tick for the target to mount
      requestAnimationFrame(() => {
        const el = document.getElementById(id);
        if (el) {
          el.scrollIntoView({ behavior: 'instant', block: 'start' });
          return;
        }
        window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      });
      return;
    }
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [pathname, hash]);

  useEffect(() => {
    const publicPath = /^\/(?:services|quote|about|areas(?:\/(?:sugar-hill|suwanee|buford|duluth|johns-creek|alpharetta|roswell))?|contact|whats-included|faq|founding|privacy|terms|thank-you)?$/.test(pathname) ? pathname : "/other";
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = trackFunnel("gh_page_view", { page_path: publicPath });
      if (reported && pathname === "/quote") trackFunnel("gh_quote_start", { form_type: "quote" });
    };
    report();
    document.addEventListener("gh-consent", report);
    return () => document.removeEventListener("gh-consent", report);
  }, [pathname]);

  return null;
}