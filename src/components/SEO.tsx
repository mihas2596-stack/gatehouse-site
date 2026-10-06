import { Helmet } from "react-helmet-async";

interface SEOProps {
  title: string;
  description: string;
  url?: string;
  ogTitle?: string;
  ogDescription?: string;
  twitterDescription?: string;
  metaDescription?: string;
  image?: string;
  noindex?: boolean;
}

const SEO = ({
  title,
  description,
  url,
  ogTitle,
  ogDescription,
  twitterDescription,
  metaDescription,
  image = "https://gatehousehomecleaning.com/og-image.png",
  noindex = false,
}: SEOProps) => {
  const finalOgTitle = ogTitle ?? title;
  const canonical = url?.replace("https://gatehousehomecleaning.com", "https://www.gatehousehomecleaning.com");
  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={metaDescription ?? description} />
      {canonical && <link rel="canonical" href={canonical} />}
      <meta name="robots" content={noindex ? "noindex, follow" : "index, follow"} />
      <meta property="og:title" content={finalOgTitle} />
      <meta property="og:description" content={ogDescription ?? description} />
      {canonical && <meta property="og:url" content={canonical} />}
      <meta property="og:image" content={image} />
      <meta property="og:image:secure_url" content={image} />
      <meta name="twitter:title" content={finalOgTitle} />
      <meta name="twitter:description" content={twitterDescription ?? description} />
      <meta name="twitter:image" content={image} />
    </Helmet>
  );
};

export default SEO;