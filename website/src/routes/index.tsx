import { Meta, Title } from "@solidjs/meta";
import Nav from "~/components/Nav";
import Hero from "~/components/Hero";
import WhatYouCanHost from "~/components/WhatYouCanHost";
import WhyOperatorOwned from "~/components/WhyOperatorOwned";
import EcosystemMap from "~/components/EcosystemMap";
import ForEveryone from "~/components/ForEveryone";
import Showcase from "~/components/Showcase";
import Comparison from "~/components/Comparison";
import Pricing from "~/components/Pricing";
import EndCTA from "~/components/EndCTA";
import Footer from "~/components/Footer";

export default function Home() {
  return (
    <>
      <Title>Takosumi — OpenTofu-native deploy control plane</Title>
      <Meta
        name="description"
        content="plain な OpenTofu module を Capsule Installation に。plan / apply / destroy は Run として記録し、Connection と policy が実行境界を決めます。cloud でも VM でも cluster でも、同じ台帳で deploy。"
      />
      <Meta property="og:site_name" content="Takosumi" />
      <Meta property="og:locale" content="ja_JP" />
      <Meta
        property="og:title"
        content="Takosumi — OpenTofu-native deploy control plane"
      />
      <Meta
        property="og:description"
        content="plain な OpenTofu module を Capsule Installation に。plan / apply は Run として記録し、Connection と policy が実行境界を決めます。cloud でも VM でも cluster でも、同じ台帳で deploy。"
      />
      <Meta property="og:url" content="https://takosumi.com/" />
      <Meta property="og:type" content="website" />
      <Meta
        property="og:image"
        content="https://takosumi.com/brand/og-cover.svg"
      />
      <Meta property="og:image:type" content="image/svg+xml" />
      <Meta property="og:image:width" content="1200" />
      <Meta property="og:image:height" content="630" />
      <Meta
        property="og:image:alt"
        content="Takosumi — OpenTofu-native deploy control plane"
      />
      <Meta name="twitter:card" content="summary_large_image" />
      <Meta
        name="twitter:title"
        content="Takosumi — OpenTofu-native deploy control plane"
      />
      <Meta
        name="twitter:description"
        content="plain な OpenTofu module を Capsule Installation に。plan / apply は Run として記録し、Connection と policy が実行境界を決めます。cloud でも VM でも cluster でも、同じ台帳で deploy。"
      />
      <Meta
        name="twitter:image"
        content="https://takosumi.com/brand/og-cover.svg"
      />

      <Nav />
      <main id="main">
        <Hero />
        <WhatYouCanHost />
        <WhyOperatorOwned />
        <EcosystemMap />
        <ForEveryone />
        <Showcase />
        <Comparison />
        <Pricing />
        <EndCTA />
      </main>
      <Footer />
    </>
  );
}
