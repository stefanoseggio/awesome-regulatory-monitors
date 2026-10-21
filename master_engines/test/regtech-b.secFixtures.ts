/**
 * Byte-exact <item> elements copied from LIVE captures of SEC's own RSS feeds on 2026-10-21 (HTTP 200,
 * application/rss+xml), plus the exact channel header/footer of each capture. Nothing in this module is
 * hand-written: the connector tests run the real parser against real upstream text, including its quirks
 * (trailing newline inside <link>, trailing newline in one <title>, PDF links for administrative proceedings).
 */

export const LIVE_LITIGATION_HEAD = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<rss xmlns:dc=\"http://purl.org/dc/elements/1.1/\" version=\"2.0\" xml:base=\"https://www.sec.gov/\">\n  <channel>\n    <title>Litigation Releases</title>\n    <link>https://www.sec.gov/</link>\n    <description>The latest Litigation Releases from the Securities and Exchange Commission</description>\n    <language>en</language>\n    \n    ";

export const LIVE_LITIGATION_TAIL = "\n\n  </channel>\n</rss>\n";

export const LIVE_LITIGATION_ITEMS: readonly string[] = [
    "<item>\n  <title>Siddhi Patel, as Administrator of the Estate of Chirayu Vijay Patel (Deceased) </title>\n  <link>https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26676\n</link>\n  <description>Siddhi Patel, as Administrator of the Estate of Chirayu Vijay Patel (Deceased) </description>\n  <pubDate>Tue, 20 Oct 2026 14:55:51 -0400</pubDate>\n    <dc:creator>LR-26676</dc:creator>\n    <guid isPermaLink=\"false\">2c3996d5-1d51-4ab8-b85c-6df267d4f7ce</guid>\n    </item>",
    "<item>\n  <title>Terrance P. Berland and David Michael Scalzo</title>\n  <link>https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26675\n</link>\n  <description>Terrance P. Berland and David Michael Scalzo</description>\n  <pubDate>Tue, 20 Oct 2026 14:47:40 -0400</pubDate>\n    <dc:creator>LR-26675</dc:creator>\n    <guid isPermaLink=\"false\">62170d43-17b6-4671-b9a5-5c21e1dd7e0f</guid>\n    </item>",
    "<item>\n  <title>Matthew Brown and Matthew Brown Companies, LLC</title>\n  <link>https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26673\n</link>\n  <description>Matthew Brown and Matthew Brown Companies, LLC</description>\n  <pubDate>Tue, 13 Oct 2026 17:21:15 -0400</pubDate>\n    <dc:creator>LR-26673</dc:creator>\n    <guid isPermaLink=\"false\">54e320d2-9546-4741-954d-db566a3e0aec</guid>\n    </item>",
    "<item>\n  <title>Cryptoaiml Ltd.; Cryptoaiml Capital Foundation; TSAI Pro Ltd.; TSAI Capital Foundation\n</title>\n  <link>https://www.sec.gov/enforcement-litigation/litigation-releases/lr-26654\n</link>\n  <description>Cryptoaiml Ltd.; Cryptoaiml Capital Foundation; TSAI Pro Ltd.; TSAI Capital Foundation&lt;br&gt;\n</description>\n  <pubDate>Tue, 29 Sep 2026 17:06:47 -0400</pubDate>\n    <dc:creator>LR-26654</dc:creator>\n    <guid isPermaLink=\"false\">2e4dcadb-fdae-4eec-bd80-71c4c82c0228</guid>\n    </item>"
];

export const LIVE_ADMIN_HEAD = "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<rss xmlns:dc=\"http://purl.org/dc/elements/1.1/\" version=\"2.0\" xml:base=\"https://www.sec.gov/\">\n  <channel>\n    <title>Administrative Proceedings</title>\n    <link>https://www.sec.gov/</link>\n    <description>The latest Administrative Proceedings from the Securities and Exchange Commission</description>\n    <language>en</language>\n    \n    ";

export const LIVE_ADMIN_TAIL = "\n\n  </channel>\n</rss>\n";

export const LIVE_ADMIN_ITEMS: readonly string[] = [
    "<item>\n  <title>Michael D. Williams</title>\n  <link>https://www.sec.gov/files/litigation/admin/2026/ia-7027.pdf\n</link>\n  <description>Michael D. Williams</description>\n  <pubDate>Thu, 15 Oct 2026 16:22:18 -0400</pubDate>\n    <dc:creator>IA-7027</dc:creator>\n    <guid isPermaLink=\"false\">a115de77-2127-4373-be34-c0aafd713d12</guid>\n    </item>",
    "<item>\n  <title>Raymond Lawrence Lent (Dba the Putney Financial Group and Registered Investment Advisors)</title>\n  <link>https://www.sec.gov/files/litigation/admin/2026/34-106673.pdf\n</link>\n  <description>Raymond Lawrence Lent (Dba the Putney Financial Group and Registered Investment Advisors)</description>\n  <pubDate>Thu, 15 Oct 2026 15:34:05 -0400</pubDate>\n    <dc:creator>34-106673</dc:creator>\n    <guid isPermaLink=\"false\">4e9a054a-ac0c-4d38-8d5d-5df15c674cae</guid>\n    </item>",
    "<item>\n  <title>Carlos Lopez, CPA</title>\n  <link>https://www.sec.gov/files/litigation/admin/2026/34-106633.pdf\n</link>\n  <description>Carlos Lopez, CPA</description>\n  <pubDate>Thu, 08 Oct 2026 10:22:21 -0400</pubDate>\n    <dc:creator>34-106633</dc:creator>\n    <guid isPermaLink=\"false\">0b0a1b9b-c5a7-4e58-8ad8-4bff1b076530</guid>\n    </item>",
    "<item>\n  <title>CityVest Capital Inc., CV Manager LLC, and Alan P. Donenfeld</title>\n  <link>https://www.sec.gov/files/litigation/admin/2026/ia-7021.pdf\n</link>\n  <description>CityVest Capital Inc., CV Manager LLC, and Alan P. Donenfeld</description>\n  <pubDate>Fri, 02 Oct 2026 16:27:45 -0400</pubDate>\n    <dc:creator>IA-7021</dc:creator>\n    <guid isPermaLink=\"false\">149924ff-44fb-47ea-a627-a61935a495c7</guid>\n    </item>",
    "<item>\n  <title>J.P. Morgan Securities LLC And JPMorgan Chase Bank, N.A.</title>\n  <link>https://www.sec.gov/files/litigation/admin/2026/34-106569.pdf\n</link>\n  <description>J.P. Morgan Securities LLC And JPMorgan Chase Bank, N.A.</description>\n  <pubDate>Fri, 02 Oct 2026 08:03:03 -0400</pubDate>\n    <dc:creator>34-106569</dc:creator>\n    <guid isPermaLink=\"false\">0cfe01ce-1600-40a4-b00a-b32b8292d01f</guid>\n    </item>"
];
