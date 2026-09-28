import { Title } from "@solidjs/meta";
import Nav from "~/components/Nav";
import Hero from "~/components/Hero";
import Why from "~/components/WhyOperatorOwned";
import WhatYouCanHost from "~/components/WhatYouCanHost";
import Showcase from "~/components/Showcase";
import Comparison from "~/components/Comparison";
import Pricing from "~/components/Pricing";
import EndCTA from "~/components/EndCTA";
import Footer from "~/components/Footer";
import AdringWidget from "~/components/AdringWidget";

export default function Home() {
  return (
    <>
      <Title>Takosumi</Title>
      <Nav />
      <main id="main">
        <Hero />
        <WhatYouCanHost />
        <Why />
        <Showcase />
        <Comparison />
        <Pricing />
        <EndCTA />
      </main>
      <Footer />
      <AdringWidget />
    </>
  );
}
