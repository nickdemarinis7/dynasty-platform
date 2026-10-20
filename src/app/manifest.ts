import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Fantasy GM Trade Intelligence",
    short_name: "Fantasy GM",
    description: "Dynasty and redraft league analysis, trades, rankings, and roster intelligence.",
    start_url: "/",
    display: "standalone",
    background_color: "#17191d",
    theme_color: "#2563eb",
    orientation: "portrait-primary",
    categories: ["sports", "utilities"],
    icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }],
  };
}
