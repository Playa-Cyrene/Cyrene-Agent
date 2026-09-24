import { useTranslation } from "../../i18n";
import "./DisclaimerSettingsPanel.css";

/** 邮箱行内图标（与旧版设置窗口免责声明保持一致）。 */
function EmailLineIcon() {
  return (
    <svg className="cy-disclaimer-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path d="M44 24V9H24H4V24V39H24" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M35 39L43 32L39 28L31 35V39H35Z" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 9L24 24L44 9" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** B 站品牌图标（官方品牌粉色保留）。 */
function BilibiliIcon() {
  return (
    <svg className="cy-disclaimer-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4.977 3.561a1.31 1.31 0 111.818-1.884l2.828 2.728c.08.078.149.163.205.254h4.277a1.32 1.32 0 01.205-.254l2.828-2.728a1.31 1.31 0 011.818 1.884L17.82 4.66h.848A5.333 5.333 0 0124 9.992v7.34a5.333 5.333 0 01-5.333 5.334H5.333A5.333 5.333 0 010 17.333V9.992a5.333 5.333 0 015.333-5.333h.781L4.977 3.56zm.356 3.67a2.667 2.667 0 00-2.666 2.667v7.529a2.667 2.667 0 002.666 2.666h13.334a2.667 2.667 0 002.666-2.666v-7.53a2.667 2.667 0 00-2.666-2.666H5.333zm1.334 5.192a1.333 1.333 0 112.666 0v1.192a1.333 1.333 0 11-2.666 0v-1.192zM16 11.09c-.736 0-1.333.597-1.333 1.333v1.192a1.333 1.333 0 102.666 0v-1.192c0-.736-.597-1.333-1.333-1.333z"
        fill="#FB7299"
      />
    </svg>
  );
}

/** GitHub 品牌图标。 */
function GithubIcon() {
  return (
    <svg className="cy-disclaimer-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M12 0c6.63 0 12 5.276 12 11.79-.001 5.067-3.29 9.567-8.175 11.187-.6.118-.825-.25-.825-.56 0-.398.015-1.665.015-3.242 0-1.105-.375-1.813-.81-2.181 2.67-.295 5.475-1.297 5.475-5.822 0-1.297-.465-2.344-1.23-3.169.12-.295.54-1.503-.12-3.125 0 0-1.005-.324-3.3 1.209a11.32 11.32 0 00-3-.398c-1.02 0-2.04.133-3 .398-2.295-1.518-3.3-1.209-3.3-1.209-.66 1.622-.24 2.83-.12 3.125-.765.825-1.23 1.887-1.23 3.169 0 4.51 2.79 5.527 5.46 5.822-.345.294-.66.81-.765 1.577-.69.31-2.415.81-3.495-.973-.225-.354-.9-1.223-1.845-1.209-1.005.015-.405.56.015.781.51.28 1.095 1.327 1.23 1.666.24.663 1.02 1.93 4.035 1.385 0 .988.015 1.916.015 2.196 0 .31-.225.664-.825.56C3.303 21.374-.003 16.867 0 11.791 0 5.276 5.37 0 12 0z"
        fill="currentColor"
      />
    </svg>
  );
}

/** 免责声明面板：从旧版设置窗口迁移的十条条款，内容与原文一致。 */
export function DisclaimerSettingsPanel() {
  const { t } = useTranslation();
  const p = (key: string) => t(`settingsPage.disclaimer.${key}`);

  return (
    <>
      <h1>{p("heading")}</h1>
      <p className="cy-settings-intro">{p("subheading")}</p>

      <div className="cy-settings-disclaimer">
        <article className="cy-settings-card cy-disclaimer-section">
          <h2>{p("section1.title")}</h2>
          <p>{p("section1.p1")}</p>
          <p>{p("section1.p2")}</p>
        </article>

        <article className="cy-settings-card cy-disclaimer-section">
          <h2>{p("section2.title")}</h2>
          <p>{p("section2.p1")}</p>
          <p>{p("section2.p2")}</p>
        </article>

        <article className="cy-settings-card cy-disclaimer-section">
          <h2>{p("section3.title")}</h2>
          <p>{p("section3.p1")}</p>
          <p>{p("section3.p2")}</p>
        </article>

        <article className="cy-settings-card cy-disclaimer-section">
          <h2>{p("section4.title")}</h2>
          <p>{p("section4.p1")}</p>
          <p>{p("section4.p2")}</p>
        </article>

        <article className="cy-settings-card cy-disclaimer-section">
          <h2>{p("section5.title")}</h2>
          <p>{p("section5.p1")}</p>
          <ul>
            <li><EmailLineIcon /> {p("section5.email")}</li>
            <li>
              <BilibiliIcon />{" "}
              <a href="https://space.bilibili.com/260670644" target="_blank" rel="noopener noreferrer">{p("section5.bilibiliLink")}</a>
              {p("section5.bilibiliNote")}
            </li>
            <li>
              <GithubIcon /> {p("section5.githubLabel")}
              <a href="https://github.com/Playa-0v0/Cyrene-Agent" target="_blank" rel="noopener noreferrer">{p("section5.githubLink")}</a>
            </li>
          </ul>
        </article>

        <article className="cy-settings-card cy-disclaimer-section">
          <h2>{p("section6.title")}</h2>
          <p>{p("section6.p1")}</p>
          <ul>
            <li><EmailLineIcon /> {p("section6.email")}</li>
            <li>
              <BilibiliIcon />{" "}
              <a href="https://space.bilibili.com/260670644" target="_blank" rel="noopener noreferrer">{p("section6.bilibiliLink")}</a>
              {p("section6.bilibiliNote")}
            </li>
            <li>
              <GithubIcon />{" "}
              <a href="https://github.com/Playa-0v0/Cyrene-Agent/issues" target="_blank" rel="noopener noreferrer">{p("section6.githubLink")}</a>
              {p("section6.githubNote")}
            </li>
          </ul>
          <p>{p("section6.outro")}</p>
        </article>

        <article className="cy-settings-card cy-disclaimer-section">
          <h2>{p("section7.title")}</h2>
          <p>{p("section7.p1")}</p>
          <p>{p("section7.p2")}</p>
          <ul>
            <li>{p("section7.li1")}</li>
            <li>{p("section7.li2")}</li>
            <li>{p("section7.li3")}</li>
            <li>{p("section7.li4")}</li>
          </ul>
        </article>

        <article className="cy-settings-card cy-disclaimer-section">
          <h2>{p("section8.title")}</h2>
          <p>
            {p("section8.p1")}
            <a href="https://space.bilibili.com/457683484" target="_blank" rel="noopener noreferrer">{p("section8.upLink")}</a>
            {p("section8.p2")}
          </p>
        </article>

        <article className="cy-settings-card cy-disclaimer-section">
          <h2>{p("section9.title")}</h2>
          <p>
            {p("section9.p1")}
            <a
              href="https://github.com/Playa-0v0/Cyrene-Agent/graphs/contributors?from=2026%2F5%2F30"
              target="_blank"
              rel="noopener noreferrer"
            >
              {p("section9.contributorsLink")}
            </a>
          </p>
          <p>{p("section9.p2")}</p>
        </article>

        <article className="cy-settings-card cy-disclaimer-section">
          <h2>{p("section10.title")}</h2>
          <p>{p("section10.p1")}</p>
        </article>
      </div>
    </>
  );
}
