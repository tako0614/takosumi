import { Meta, Title } from "@solidjs/meta";
import Nav from "~/components/Nav";
import Hero from "~/components/Hero";
import WhatYouCanHost from "~/components/WhatYouCanHost";
import WhyOperatorOwned from "~/components/WhyOperatorOwned";
import EcosystemMap from "~/components/EcosystemMap";
import ForEveryone from "~/components/ForEveryone";
import Showcase from "~/components/Showcase";
import Comparison from "~/components/Comparison";
import EndCTA from "~/components/EndCTA";
import Footer from "~/components/Footer";

export default function Home() {
  return (
    <>
      <Title>
        Takosumi — An Open Source, Operator-Portable Platform for Everything
      </Title>
      <Meta
        name="description"
        content="chat も docs も agent も SNS も、 自分の DB も —— 1 つの Takosumi の上で、 cloud でも VM でも cluster でも、 同じ Space が動く。"
      />
      <Meta
        property="og:title"
        content="Takosumi — An Open Source, Operator-Portable Platform for Everything"
      />
      <Meta
        property="og:description"
        content="Manifest、Installation、Deployment を共通化し、実行先は operator が選ぶ。cloud でも VM でも cluster でも同じ Space が動く。"
      />
      <Meta property="og:url" content="https://takosumi.com/" />
      <Meta property="og:type" content="website" />
      <Meta
        property="og:image"
        content="https://takosumi.com/brand/geometric.svg"
      />

      <Nav />
      <main>
        <Hero />
        <WhatYouCanHost />
        <WhyOperatorOwned />
        <EcosystemMap />
        <ForEveryone />
        <Showcase />
        <Comparison />
        <EndCTA />
      </main>
      <Footer />
    </>
  );
}
