import { Title } from "@solidjs/meta";
import Nav from "~/components/Nav";
import Hero from "~/components/Hero";
import Ledger from "~/components/Ledger";
import Why from "~/components/WhyOperatorOwned";
import WhatYouCanHost from "~/components/WhatYouCanHost";
import Pricing from "~/components/Pricing";
import CurlRule from "~/components/CurlRule";
import Footer from "~/components/Footer";
import AdringWidget from "~/components/AdringWidget";

export default function Home() {
  return (
    <>
      <Title>Takosumi</Title>
      <Nav />
      <main id="main">
        <Hero />
        <Ledger />
        <WhatYouCanHost />
        <Why />
        <Pricing />
      </main>
      <AdringWidget />
      <CurlRule />
      <Footer />
    </>
  );
}
