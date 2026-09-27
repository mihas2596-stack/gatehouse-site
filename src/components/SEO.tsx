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
}: SEOProps) => {
  const finalOgTitle = ogTitle ?? title;
  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={metaDescription ?? description} />
      {url && <link rel="canonical" href={url} />}
      <meta property="og:title" content={finalOgTitle} />
      <meta property="og:description" content={ogDescription ?? description} />
      {url && <meta property="og:url" content={url} />}
      <meta property="og:image" content={image} />
      <meta property="og:image:secure_url" content={image} />
      <meta name="twitter:title" content={finalOgTitle} />
      <meta name="twitter:description" content={twitterDescription ?? description} />
      <meta name="twitter:image" content={image} />
    </Helmet>
  );
};

export default SEO;