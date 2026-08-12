import { withOAuthNoStoreHeaders } from "../../../../accounts/service/src/http-helpers.ts";

const signInTarget = "https://accounts.example.test/sign-in?return=%2Foauth%2Fauthorize";
const codeTarget = "https://client.example.test/oauth/callback?code=one-shot-code&state=request-state";

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    const target = url.pathname.endsWith("/code") ? codeTarget : signInTarget;
    const response = withOAuthNoStoreHeaders(Response.redirect(target, 302));
    response.headers.set("vary", "Cookie, Sec-Fetch-Dest");
    return response;
  },
};
