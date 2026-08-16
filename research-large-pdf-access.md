# Large PDF partial-access research

## Verified findings

1. Telegram MTProto `upload.getFile` officially supports retrieving a whole file or a part using `offset` and `limit` byte parameters. The method is available to both users and bots. Source: https://core.telegram.org/method/upload.getFile
2. Telegram's local Bot API server supports large downloads without the cloud Bot API download limit, but the standard Bot API wrapper does not expose the MTProto `upload.getFile` offset/limit method directly. Source: https://github.com/tdlib/telegram-bot-api
3. Telegram's MTProto file API transfers byte ranges, not PDF pages. The application must first parse enough PDF structure to know which byte ranges contain the page tree and page content.
4. Normal PDFs usually place the cross-reference table and trailer near the end of the file. Those structures identify object offsets, so the first bytes alone do not reliably locate page 1. Linearized PDFs are the exception: they put first-page hints and relevant objects near the beginning to support partial loading. Source: https://gendignoux.com/blog/2016/10/04/pdf-basics.html
5. PDF.js supports fetching only required portions when the server supports range requests, but it still relies on PDF structure and is not a universal first-1–3-MB solution for arbitrary PDFs. Source: https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions
6. A viable page-sampling architecture requires an MTProto-capable worker or Telegram client library, not only a Vercel webhook and not only the ordinary Bot API `getFile` method.

## Recommended strategy

Use a worker on Render or another persistent host that receives the Telegram document identity. It should fetch small byte ranges using MTProto `upload.getFile`: the PDF header/initial bytes, a tail range containing `startxref` and trailer, then only the xref/object ranges needed for the page tree and first 1–3 pages. It should use a bounded range cache and stop after enough text operators are found. For linearized PDFs, it can often inspect the first-page region directly. For non-linearized or encrypted/corrupt PDFs, it should return `Needs full inspection` instead of claiming a definitive classification.

Forwarding should remain server-side using Telegram message copy/forward operations, so the PDF is not downloaded to Render merely to re-upload it to the channel.
