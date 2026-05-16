import { Meta, Title } from "@solidjs/meta";
import Nav from "~/components/Nav";
import Hero from "~/components/Hero";
import Substrates from "~/components/Substrates";
import WhyPillars from "~/components/WhyPillars";
import FeatureGrid from "~/components/FeatureGrid";
import Showcase from "~/components/Showcase";
import Comparison from "~/components/Comparison";
import EndCTA from "~/components/EndCTA";
import Footer from "~/components/Footer";

export default function Home() {
  return (
    <>
      <Title>Takosumi — どこの cloud にも同じ 1 行で deploy</Title>
      <Meta name="description" content="AWS、 Cloudflare、 Kubernetes、 docker、 自前 VM — 全部に takosumi deploy 1 コマンドで届く。 引っ越しは manifest を 1 行変えるだけ。" />
      <Meta property="og:title" content="Takosumi — どこの cloud にも同じ 1 行で deploy" />
      <Meta property="og:description" content="AWS, Cloudflare, Kubernetes, docker, 自前 VM。 一度書いたら全部に届く self-host PaaS。" />
      <Meta property="og:url" content="https://takosumi.com/" />
      <Meta property="og:type" content="website" />
      <Meta property="og:image" content="https://takosumi.com/brand/geometric.svg" />

      <Nav />
      <main>
        <Hero />
        <Substrates />
        <WhyPillars />
        <FeatureGrid />
        <Showcase />
        <Comparison />
        <EndCTA />
      </main>
      <Footer />
    </>
  );
}
