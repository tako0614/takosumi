import { Title } from "@solidjs/meta";
import Nav from "~/components/Nav";
import Hero from "~/components/Hero";
import SplatField from "~/components/SplatField";
import Why from "~/components/WhyOperatorOwned";
import WhatYouCanHost from "~/components/WhatYouCanHost";
import Showcase from "~/components/Showcase";
import Stats from "~/components/Stats";
import Comparison from "~/components/Comparison";
import Pricing from "~/components/Pricing";
import EndCTA from "~/components/EndCTA";
import Footer from "~/components/Footer";

export default function Home() {
  return (
    <>
      <Title>Takosumi — your service, your server.</Title>
      <Nav />
      <main id="main">
        <Hero />
        <div class="ink-canvas">
          <SplatField density="page" />
          <WhatYouCanHost />
          <Why />
          <Showcase />
          <Stats />
          <Comparison />
          <Pricing />
          <EndCTA />
        </div>
      </main>
      <Footer />
    </>
  );
}
