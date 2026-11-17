// Classificação segura de conteúdo da Biblioteca de arquivos.
//
// O mimeType gravado no upload é DECLARADO pelo cliente e não prova
// nada. A entrega HTTP deriva a classificação da extensão do
// storageName (gerado no servidor) + assinatura real do conteúdo
// (magic bytes / sniffing de texto). Somente conteúdo verificado
// como inerte pode ser servido inline; todo o resto desce como
// anexo octet-stream com CSP sandbox — inclusive arquivos antigos,
// importados ou restaurados com metadados incorretos.

import { closeSync, openSync, readSync } from "node:fs";

export interface ClasseArquivo {
  /** conteúdo reconhecido como formato seguro conhecido */
  reconhecido: boolean;
  /** extensão do storageName corresponde ao conteúdo verificado */
  extensaoCompativel: boolean;
  /** MIME canônico seguro para a resposta HTTP */
  mime: string;
  /** pode ser exibido inline na origem */
  inline: boolean;
  /** deve ser entregue como attachment */
  attachment: boolean;
  /** exige Content-Security-Policy: sandbox na resposta */
  sandbox: boolean;
}

const ANEXO: ClasseArquivo = {
  reconhecido: false, extensaoCompativel: false,
  mime: "application/octet-stream",
  inline: false, attachment: true, sandbox: true,
};

function inline(mime: string): ClasseArquivo {
  return { reconhecido: true, extensaoCompativel: true, mime, inline: true, attachment: false, sandbox: false };
}

const txt = (b: Buffer, o: number, n: number) => b.toString("latin1", o, Math.min(o + n, b.length));
const riff = (b: Buffer) => txt(b, 0, 4) === "RIFF";

/** Assinaturas verificáveis por extensão. Retorna o MIME canônico
 *  somente quando os magic bytes são coerentes com a extensão. */
const ASSINATURAS: Record<string, { mime: string; ok: (b: Buffer) => boolean }> = {
  // assinatura PNG completa: 89 50 4E 47 0D 0A 1A 0A
  png: { mime: "image/png", ok: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  jpg: { mime: "image/jpeg", ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: "image/jpeg", ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  gif: { mime: "image/gif", ok: (b) => txt(b, 0, 3) === "GIF" },
  webp: { mime: "image/webp", ok: (b) => riff(b) && txt(b, 8, 4) === "WEBP" },
  bmp: { mime: "image/bmp", ok: (b) => txt(b, 0, 2) === "BM" },
  ico: { mime: "image/x-icon", ok: (b) => b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 },
  pdf: { mime: "application/pdf", ok: (b) => txt(b, 0, 5) === "%PDF-" },
  mp3: { mime: "audio/mpeg", ok: (b) => txt(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  wav: { mime: "audio/wav", ok: (b) => riff(b) && txt(b, 8, 4) === "WAVE" },
  ogg: { mime: "audio/ogg", ok: (b) => txt(b, 0, 4) === "OggS" },
  flac: { mime: "audio/flac", ok: (b) => txt(b, 0, 4) === "fLaC" },
  m4a: { mime: "audio/mp4", ok: (b) => txt(b, 4, 4) === "ftyp" },
  mp4: { mime: "video/mp4", ok: (b) => txt(b, 4, 4) === "ftyp" },
  mov: { mime: "video/quicktime", ok: (b) => txt(b, 4, 4) === "ftyp" },
  webm: { mime: "video/webm", ok: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  mkv: { mime: "video/x-matroska", ok: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  avi: { mime: "video/x-msvideo", ok: (b) => riff(b) && txt(b, 8, 3) === "AVI" },
};

/** Extensões servidas como texto puro quando o conteúdo não demonstra
 *  ser marcação/conteúdo ativo. */
const EXT_TEXTO = new Set(["txt", "md", "csv", "json", "xml"]);

/** Detecta conteúdo que se apresenta como marcação ativa (SVG, HTML,
 *  XHTML, XML, scripts). Um documento de texto que começa com "<"
 *  não é texto comum — é tratado como não verificável. */
function pareceConteudoAtivo(head: Buffer): boolean {
  let i = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3; // BOM UTF-8
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
  if (i >= head.length) return false; // só espaços — texto vazio inócuo
  if (head[i] !== 0x3c) return false; // '<'
  const inicio = head.toString("latin1", i, Math.min(i + 512, head.length)).toLowerCase();
  return /<\s*(svg|html|!doctype|\?xml|script|body|head|\?xml-stylesheet)/.test(inicio)
    || /^<\s*[a-z!]/.test(inicio);
}

/** Classifica o conteúdo REAL de um arquivo da biblioteca.
 *  `storageName` deve ser o nome físico gerado no servidor (nunca o
 *  fileName do cliente); `conteudo` é o início do arquivo — alguns
 *  KB bastam para magic bytes e sniffing de texto. */
export function classificarConteudoArquivo(storageName: string, conteudo: Buffer | null | undefined): ClasseArquivo {
  if (!conteudo || conteudo.length === 0) return ANEXO;
  const m = /\.([A-Za-z0-9]+)$/.exec(storageName);
  const ext = m ? m[1].toLowerCase() : "";
  if (!ext) return ANEXO;

  const ass = ASSINATURAS[ext];
  if (ass) return ass.ok(conteudo) ? inline(ass.mime) : ANEXO;

  if (EXT_TEXTO.has(ext)) {
    return pareceConteudoAtivo(conteudo) ? ANEXO : inline("text/plain; charset=utf-8");
  }

  return ANEXO;
}

/** Lê os primeiros bytes do arquivo — suficiente para classificação
 *  sem carregar arquivos grandes inteiros em memória. */
export function inicioDoArquivo(caminho: string, n = 8192): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(caminho, "r");
    const b = Buffer.alloc(n);
    const lidos = readSync(fd, b, 0, n, 0);
    return b.subarray(0, lidos);
  } catch { return null; } finally { if (fd !== null) { try { closeSync(fd); } catch { } } }
}
