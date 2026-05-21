import { Meta, Title } from "@solidjs/meta";
import Nav from "~/components/Nav";
import Hero from "~/components/Hero";
import WhySelfHost from "~/components/WhySelfHost";
import Showcase from "~/components/Showcase";
import Comparison from "~/components/Comparison";
import EndCTA from "~/components/EndCTA";
import Footer from "~/components/Footer";

export default function Home() {
  return (
    <>
      <Title>
        Takosumi — An Open Source, Self-Hostable Platform for Everything
      </Title>
      <Meta
        name="description"
        content="chat も docs も agent も SNS も、 自分の DB も —— 1 つの Takosumi の上で、 自分の host に。 cloud でも自宅の docker でも、 同じ Space が動く。 Takosumi は open source な self-host platform、 全ての人のために。"
      />
      <Meta
        property="og:title"
        content="Takosumi — An Open Source, Self-Hostable Platform for Everything"
      />
      <Meta
        property="og:description"
        content="chat / docs / agent / SNS / DB を 1 つの Takosumi の上で、 自分の host に。 open source な self-host platform、 全ての人のために。"
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
        <WhySelfHost />
        <Showcase />
        <Comparison />
        <EndCTA />
      </main>
      <Footer />
    </>
  );
}
