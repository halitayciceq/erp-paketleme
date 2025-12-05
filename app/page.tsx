"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableCell,
  TableBody,
} from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import QRCode from "qrcode";

/**
 * ERP Paketleme Paneli
 * - Sipariş listesi
 * - Ürün listesi (kalan, atanan paket(ler), ata)
 * - Palet / Sandık yönetimi (durum: Hazırlanıyor -> Kapat/Tamamlandı)
 * - QR: Container ve Sipariş level yazdırma önizleme
 * - “Kalan=0” ise ürün bazında Tamamlandı rozetleri
 */

type Siparis = {
  no: string;
  tarih: string;
  teslim: string;
  adi: string;
  surec: string;
  asama: string;
  proje: string;
};

type UrunAtama = { no: string; adet: number };

type Urun = {
  kod: string;
  ad: string;
  adet: number; // toplam
  tur: "Palet" | "Sandık" | string;
  atananlar: UrunAtama[]; // paket/palet bazında dağıtımlar
  kalan: number;
};

type Konteyner = {
  no: string; // P001 / S002
  tip: "Palet" | "Sandık";
  siparis: string; // Sipariş no
  urunKodlari: string[]; // benzersiz ürün kodları
  adet: number; // konteynerdeki toplam adet
  durum: "Hazırlanıyor" | "Tamamlandı" | string;
};

type PrintTarget =
  | { type: "order"; orderNo: string }
  | { type: "container"; containerNo: string };

export default function PaketlemeTakipPaneli() {
  const [selectedSiparis, setSelectedSiparis] = useState<Siparis | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [selectedUrun, setSelectedUrun] = useState<Urun | null>(null);

  // Modal state
  const [paketTipi, setPaketTipi] = useState<"palet" | "sandik" | "">("");
  const [seciliKonteyner, setSeciliKonteyner] = useState<string>(""); // mevcut no veya "yeni"
  const [adet, setAdet] = useState<number>(0);
  const [hata, setHata] = useState<string>("");

  // Badge edit state
  const [editPK, setEditPK] = useState<{ urunKod: string; paketNo: string } | null>(null);
  const [editQty, setEditQty] = useState<number>(0);

  // Print Preview state
  const [printOpen, setPrintOpen] = useState(false);
  const [printTarget, setPrintTarget] = useState<PrintTarget | null>(null);
  const [qrMap, setQrMap] = useState<Record<string, string>>({}); // containerNo | order:<no> | <order>-<container>
  const [orderQR, setOrderQR] = useState<string>("");

  // DEMO veriler
  const siparisler: Siparis[] = [
    {
      no: "SA-250355",
      tarih: "21/10/2025",
      teslim: "24/01/2026",
      adi: "10 - 16 TON ÇKK GEZER VİNÇ",
      surec: "Sevke Aktarıldı",
      asama: "Checklist Hazırlandı",
      proje: "10 - 16 TON ÇKK GEZER VİNÇ",
    },
  ];

  const [urunler, setUrunler] = useState<Urun[]>([
    {
      kod: "URN-00045",
      ad: "Çelik Kiriş",
      adet: 10,
      tur: "Sandık",
      atananlar: [
        { no: "P001", adet: 5 },
        { no: "S002", adet: 5 },
      ],
      kalan: 0,
    },
    { kod: "URN-00046", ad: "Motor Ünitesi", adet: 2, tur: "Palet", atananlar: [], kalan: 2 },
    { kod: "URN-00047", ad: "Kumanda Paneli", adet: 5, tur: "Palet", atananlar: [], kalan: 5 },
  ]);

  const [paletler, setPaletler] = useState<Konteyner[]>([
    { no: "P001", tip: "Palet", siparis: "SA-250355", urunKodlari: ["URN-00045"], adet: 5, durum: "Hazırlanıyor" },
    { no: "S002", tip: "Sandık", siparis: "SA-250355", urunKodlari: ["URN-00045"], adet: 5, durum: "Hazırlanıyor" },
  ]);

  // ----- derived -----
  const paletMap = useMemo(() => {
    const map = new Map<string, Konteyner>();
    for (const p of paletler) map.set(p.no, p);
    return map;
  }, [paletler]);

  const paletlerFlat = useMemo(
    () =>
      paletler.map((p) => ({
        ...p,
        urunSayisi: new Set(p.urunKodlari).size,
      })),
    [paletler]
  );

  const mevcutListesi = useMemo(() => {
    if (!paketTipi) return [] as Konteyner[];
    const tipLabel = paketTipi === "palet" ? "Palet" : "Sandık";
    return paletlerFlat.filter((p) => p.tip === tipLabel);
  }, [paketTipi, paletlerFlat]);

  const tumUrunlerTamamlandi = useMemo(() => urunler.every((u) => u.kalan === 0), [urunler]);

  // ----- helpers -----
  const handleAtaClick = (urun: Urun) => {
    setSelectedUrun(urun);
    setPaketTipi("");
    setSeciliKonteyner("");
    setAdet(0);
    setHata("");
    setShowModal(true);
  };

  const nextCode = (tip: "Palet" | "Sandık") => {
    const prefix = tip === "Palet" ? "P" : "S";
    const nums = paletler
      .filter((p) => p.tip === tip)
      .map((p) => parseInt(p.no.replace(/\D/g, ""), 10))
      .filter((n) => !isNaN(n));
    const max = nums.length ? Math.max(...nums) : 0;
    const next = String(max + 1).padStart(3, "0");
    return `${prefix}${next}`;
  };

  const getContainerLines = (no: string) => {
    const lines: { kod: string; ad: string; adet: number }[] = [];
    for (const u of urunler) {
      const found = u.atananlar.find((a) => a.no === no);
      if (found) lines.push({ kod: u.kod, ad: u.ad, adet: found.adet });
    }
    return lines;
  };

  const getOrderContainers = (orderNo: string) => paletler.filter((p) => p.siparis === orderNo);

  const getOrderItemSummary = (orderNo: string) => {
    const containers = new Set(getOrderContainers(orderNo).map((c) => c.no));
    const map = new Map<string, { kod: string; ad: string; adet: number }>();
    for (const u of urunler) {
      let sum = 0;
      for (const a of u.atananlar) if (containers.has(a.no)) sum += a.adet;
      if (sum > 0) map.set(u.kod, { kod: u.kod, ad: u.ad, adet: sum });
    }
    return Array.from(map.values());
  };

  const recomputeContainersFromUrunler = (urunlerYeni: Urun[]) => {
    // urunlerden aggregate; adet=0 konteynerler de korunur
    const agg = new Map<string, { adet: number; set: Set<string> }>();
    for (const u of urunlerYeni) {
      for (const a of u.atananlar) {
        if (!agg.has(a.no)) agg.set(a.no, { adet: 0, set: new Set<string>() });
        const cur = agg.get(a.no)!;
        cur.adet += a.adet;
        cur.set.add(u.kod);
      }
    }
    const out: Konteyner[] = [];
    const allNos = new Set<string>([...paletler.map((p) => p.no), ...Array.from(agg.keys())]);
    for (const no of allNos) {
      const val = agg.get(no);
      const prev = paletMap.get(no);
      out.push({
        no,
        tip: prev?.tip || (no.startsWith("S") ? "Sandık" : "Palet"),
        siparis: selectedSiparis?.no || siparisler[0].no,
        urunKodlari: val ? Array.from(val.set) : prev?.urunKodlari || [],
        adet: val ? val.adet : 0,
        durum: prev?.durum || "Hazırlanıyor",
      });
    }
    setPaletler(out);
  };

  const kaydetAtama = () => {
    if (!selectedUrun) return;
    const kalan = selectedUrun.kalan;
    const tipLabel: "Palet" | "Sandık" | "" =
      paketTipi === "palet" ? "Palet" : paketTipi === "sandik" ? "Sandık" : "";

    if (!paketTipi) {
      setHata("Paket tipi seçilmelidir.");
      return;
    }
    if (!seciliKonteyner) {
      setHata("Mevcut konteyner seçilmeli veya Yeni oluşturulmalıdır.");
      return;
    }
    if (!adet || adet < 1) {
      setHata("Dağıtılacak adet 1 veya daha büyük olmalıdır.");
      return;
    }
    if (adet > kalan) {
      setHata(`Dağıtılacak adet kalan miktarı (${kalan}) aşamaz.`);
      return;
    }

    let hedefNo = seciliKonteyner;
    if (seciliKonteyner === "yeni") {
      if (!tipLabel) {
        setHata("Yeni oluşturmak için paket tipi seçin.");
        return;
      }
      hedefNo = nextCode(tipLabel);
    }

    // Ürün güncelle
    const urunlerYeni = urunler.map((u) => {
      if (u.kod !== selectedUrun.kod) return u;
      const yeniKalan = (u.kalan || 0) - adet;
      const idx = u.atananlar.findIndex((a) => a.no === hedefNo);
      const yeniAtananlar = [...u.atananlar];
      if (idx === -1) yeniAtananlar.push({ no: hedefNo, adet });
      else yeniAtananlar[idx] = { ...yeniAtananlar[idx], adet: yeniAtananlar[idx].adet + adet };
      return { ...u, kalan: yeniKalan, atananlar: yeniAtananlar };
    });

    setUrunler(urunlerYeni);
    recomputeContainersFromUrunler(urunlerYeni);
    setShowModal(false);
  };

  // -------- Badge Edit Handlers ---------
  const openEditPopover = (u: Urun, a: UrunAtama) => {
    setEditPK({ urunKod: u.kod, paketNo: a.no });
    setEditQty(a.adet);
  };

  const commitEditQty = () => {
    if (!editPK) return;
    setUrunler((prev) => {
      const urunlerYeni = prev.map((u) => {
        if (u.kod !== editPK.urunKod) return u;
        const others = u.atananlar.filter((a) => a.no !== editPK.paketNo);
        const othersSum = others.reduce((s, a) => s + a.adet, 0);
        const maxAllowed = u.adet - othersSum; // bu pakete atanabilecek üst sınır
        const newQty = Math.max(0, Math.min(editQty, maxAllowed));
        const yeniAtananlar = newQty === 0 ? others : [...others, { no: editPK.paketNo, adet: newQty }];
        const yeniKalan = u.adet - yeniAtananlar.reduce((s, a) => s + a.adet, 0);
        return { ...u, atananlar: yeniAtananlar, kalan: yeniKalan };
      });
      recomputeContainersFromUrunler(urunlerYeni);
      return urunlerYeni;
    });
    setEditPK(null);
  };

  const removeFromContainer = () => {
    if (!editPK) return;
    setUrunler((prev) => {
      const urunlerYeni = prev.map((u) => {
        if (u.kod !== editPK!.urunKod) return u;
        const yeniAtananlar = u.atananlar.filter((a) => a.no !== editPK!.paketNo);
        const yeniKalan = u.adet - yeniAtananlar.reduce((s, a) => s + a.adet, 0);
        return { ...u, atananlar: yeniAtananlar, kalan: yeniKalan };
      });
      recomputeContainersFromUrunler(urunlerYeni);
      return urunlerYeni;
    });
    setEditPK(null);
  };

  // -------- Container Status (Kapat -> Tamamlandı) ---------
  const sealContainer = (no: string) => {
    setPaletler((prev) => prev.map((p) => (p.no === no ? { ...p, durum: "Tamamlandı" } : p)));
  };

  // -------- Print Preview ---------
  const openOrderPrint = (orderNo: string) => {
    setPrintTarget({ type: "order", orderNo });
    setPrintOpen(true);
  };

  const openContainerPrint = (containerNo: string) => {
    setPrintTarget({ type: "container", containerNo });
    setPrintOpen(true);
  };

  // Print QR üretimi (hedefe göre)
  useEffect(() => {
    const run = async () => {
      if (!printTarget) return;
      const newMap: Record<string, string> = {};
      if (printTarget.type === "container") {
        const no = printTarget.containerNo;
        const payload = {
          type: "container",
          no,
          order: paletMap.get(no)?.siparis || siparisler[0].no,
          items: getContainerLines(no),
        };
        newMap[no] = await QRCode.toDataURL(JSON.stringify(payload));
      } else {
        // order-level tek QR + opsiyonel container QR'leri
        const items = getOrderItemSummary(printTarget.orderNo);
        const containers = getOrderContainers(printTarget.orderNo).map((c) => ({
          no: c.no,
          tip: c.tip,
        }));
        newMap[`order:${printTarget.orderNo}`] = await QRCode.toDataURL(
          JSON.stringify({ type: "order", order: printTarget.orderNo, items, containers })
        );
        for (const c of getOrderContainers(printTarget.orderNo)) {
          const payload = { type: "container", no: c.no, order: c.siparis, items: getContainerLines(c.no) };
          newMap[`${printTarget.orderNo}-${c.no}`] = await QRCode.toDataURL(JSON.stringify(payload));
        }
      }
      setQrMap(newMap);
    };
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printTarget]);

  // Panel üstünde “tek sipariş QR” göstermek istersek:
  useEffect(() => {
    const run = async () => {
      const ord = selectedSiparis?.no;
      if (!ord) {
        setOrderQR("");
        return;
      }
      const items = getOrderItemSummary(ord);
      const containers = getOrderContainers(ord).map((c) => ({ no: c.no, tip: c.tip }));
      const orderPayload = { type: "order", order: ord, items, containers };
      setOrderQR(await QRCode.toDataURL(JSON.stringify(orderPayload)));
    };
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSiparis, urunler, paletler]);

  // Basit dev testleri
  useEffect(() => {
    const p = nextCode("Palet");
    console.assert(/^P\d{3}$/.test(p), `nextCode Palet format hatası: ${p}`);
    const s = nextCode("Sandık");
    console.assert(/^S\d{3}$/.test(s), `nextCode Sandık format hatası: ${s}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- render -----
  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">Paketleme Takip Paneli</h1>

      {/* Sipariş arama / liste */}
      <Card className="p-4">
        <div className="grid grid-cols-5 gap-2 mb-4">
          <Input placeholder="Sipariş No" />
          <Input placeholder="Proje Adı" />
          <Input placeholder="Başlangıç Tarihi" type="date" />
          <Input placeholder="Bitiş Tarihi" type="date" />
          <Button>Listele</Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>No</TableHead>
              <TableHead>Sipariş Tarihi</TableHead>
              <TableHead>Teslim Tarihi</TableHead>
              <TableHead>Sipariş Adı</TableHead>
              <TableHead>Süreç</TableHead>
              <TableHead>Aşama</TableHead>
              <TableHead>Proje</TableHead>
              <TableHead>Print</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {siparisler.map((s, i) => (
              <TableRow
                key={i}
                onClick={() => setSelectedSiparis(s)}
                className="cursor-pointer hover:bg-gray-100"
              >
                <TableCell>{s.no}</TableCell>
                <TableCell>{s.tarih}</TableCell>
                <TableCell>{s.teslim}</TableCell>
                <TableCell>{s.adi}</TableCell>
                <TableCell>{s.surec}</TableCell>
                <TableCell>{s.asama}</TableCell>
                <TableCell>{s.proje}</TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    disabled={!tumUrunlerTamamlandi}
                    title={
                      tumUrunlerTamamlandi
                        ? "Sipariş Özeti Yazdır"
                        : "Tüm ürünler tamamlanınca aktif olur"
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      openOrderPrint(s.no);
                    }}
                  >
                    🖨️
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Sipariş detayı */}
      {selectedSiparis && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Sipariş Detayı: {selectedSiparis.no}</h2>
            <div className="flex items-center gap-2">
              {tumUrunlerTamamlandi && (
                <span className="px-2 py-1 text-xs rounded bg-green-100 border border-green-300">
                  Paketleme Tamamlandı
                </span>
              )}
              {orderQR && (
                <div className="flex items-center gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={orderQR} alt="order-qr" className="w-16 h-16 border rounded" />
                  <Button size="sm" onClick={() => openOrderPrint(selectedSiparis.no)}>
                    Barkod Yazdır
                  </Button>
                </div>
              )}
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ürün Kodu</TableHead>
                <TableHead>Ürün Adı</TableHead>
                <TableHead>Adet</TableHead>
                <TableHead>Paket Türü</TableHead>
                <TableHead>Atanan Paket(ler)</TableHead>
                <TableHead>Kalan</TableHead>
                <TableHead>İşlem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {urunler.map((u, i) => (
                <TableRow key={i}>
                  <TableCell>{u.kod}</TableCell>
                  <TableCell>{u.ad}</TableCell>
                  <TableCell>{u.adet}</TableCell>
                  <TableCell>{u.tur}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {u.atananlar && u.atananlar.length > 0 ? (
                        u.atananlar.map((a, idx) => (
                          <Popover
                            key={`${u.kod}-${a.no}-${idx}`}
                            open={!!editPK && editPK.urunKod === u.kod && editPK.paketNo === a.no}
                            onOpenChange={(open) => {
                              if (!open) setEditPK(null);
                            }}
                          >
                            <PopoverTrigger asChild>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openEditPopover(u, a)}
                              >
                                {a.no} ({a.adet})
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-64">
                              <div className="space-y-2">
                                <div className="text-sm font-medium">Adet Güncelle</div>
                                <Input
                                  type="number"
                                  value={
                                    editPK && editPK.urunKod === u.kod && editPK.paketNo === a.no
                                      ? editQty
                                      : a.adet
                                  }
                                  onChange={(e) =>
                                    setEditQty(parseInt(e.target.value || "0", 10))
                                  }
                                />
                                <div className="flex gap-2 justify-end">
                                  <Button variant="destructive" onClick={removeFromContainer}>
                                    Paketten çıkar
                                  </Button>
                                  <Button onClick={commitEditQty}>Güncelle</Button>
                                </div>
                              </div>
                            </PopoverContent>
                          </Popover>
                        ))
                      ) : (
                        <span className="text-muted-foreground">Henüz Atanmadı</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span>{u.kalan}</span>
                      {u.kalan === 0 && (
                        <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 border border-green-300">
                          Tamamlandı
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button size="sm" onClick={() => handleAtaClick(u)}>
                      📦 Ata
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Palet / Sandık Yönetimi */}
      <Card className="p-4">
        <h2 className="text-xl font-semibold mb-4">Palet / Sandık Yönetimi</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>No</TableHead>
              <TableHead>Tip</TableHead>
              <TableHead>Sipariş No</TableHead>
              <TableHead>Ürün Sayısı</TableHead>
              <TableHead>Toplam Adet</TableHead>
              <TableHead>Durum</TableHead>
              <TableHead>Aksiyon</TableHead>
              <TableHead>Print</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paletlerFlat.map((p, i) => (
              <TableRow key={i}>
                <TableCell>{p.no}</TableCell>
                <TableCell>{p.tip}</TableCell>
                <TableCell>{p.siparis}</TableCell>
                <TableCell>{(p as any).urunSayisi}</TableCell>
                <TableCell>{p.adet}</TableCell>
                <TableCell>{p.durum}</TableCell>
                <TableCell>
                  {p.durum !== "Tamamlandı" && (
                    <Button size="sm" variant="secondary" onClick={() => sealContainer(p.no)}>
                      Kapat
                    </Button>
                  )}
                </TableCell>
                <TableCell>
                  <Button size="sm" onClick={() => openContainerPrint(p.no)}>
                    🖨️ Etiket
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Print Preview Dialog */}
      <Dialog open={printOpen} onOpenChange={setPrintOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Yazdırma Önizleme</DialogTitle>
          </DialogHeader>
          {printTarget && (
            <div className="space-y-4">
              {printTarget.type === "container" ? (
                <div className="border rounded p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-lg font-bold">{printTarget.containerNo}</div>
                      <div className="text-sm">
                        {paletMap.get(printTarget.containerNo)?.tip ||
                          (printTarget.containerNo.startsWith("S") ? "Sandık" : "Palet")}
                        {" · "}Sipariş:{" "}
                        {paletMap.get(printTarget.containerNo)?.siparis || siparisler[0].no}
                      </div>
                      <div className="mt-1 text-xs">Tarih: {new Date().toLocaleDateString()}</div>
                    </div>
                    {qrMap[printTarget.containerNo] && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={qrMap[printTarget.containerNo]} alt="qr" className="w-24 h-24" />
                    )}
                  </div>
                  <div className="mt-3 text-sm font-medium">İçerik</div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Ürün</TableHead>
                        <TableHead>Adet</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {getContainerLines(printTarget.containerNo).map((l, idx) => (
                        <TableRow key={idx}>
                          <TableCell>
                            {l.kod} - {l.ad}
                          </TableCell>
                          <TableCell>{l.adet}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="text-base font-semibold">Sipariş: {printTarget.orderNo}</div>
                    {qrMap[`order:${printTarget.orderNo}`] && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={qrMap[`order:${printTarget.orderNo}`]}
                        alt="order-qr"
                        className="w-24 h-24"
                      />
                    )}
                  </div>

                  <div className="border rounded p-3">
                    <div className="text-sm font-medium">Ürün Özeti</div>
                    <Table className="mt-2">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Ürün</TableHead>
                          <TableHead>Toplam Adet</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {getOrderItemSummary(printTarget.orderNo).map((l, idx) => (
                          <TableRow key={idx}>
                            <TableCell>
                              {l.kod} - {l.ad}
                            </TableCell>
                            <TableCell>{l.adet}</TableCell>
                          </TableRow>
                        ))}
                        {getOrderItemSummary(printTarget.orderNo).length === 0 && (
                          <TableRow>
                            <TableCell colSpan={2} className="text-muted-foreground text-xs">
                              Bu siparişte atanmış ürün yok
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>

                  <div className="border rounded p-3">
                    <div className="text-sm font-medium">Palet / Sandık Listesi</div>
                    <Table className="mt-2">
                      <TableHeader>
                        <TableRow>
                          <TableHead>No</TableHead>
                          <TableHead>Tip</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {getOrderContainers(printTarget.orderNo).map((c, idx) => (
                          <TableRow key={idx}>
                            <TableCell>{c.no}</TableCell>
                            <TableCell>{c.tip}</TableCell>
                          </TableRow>
                        ))}
                        {getOrderContainers(printTarget.orderNo).length === 0 && (
                          <TableRow>
                            <TableCell colSpan={2} className="text-muted-foreground text-xs">
                              Bu siparişe ait konteyner yok
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setPrintOpen(false)}>
                  Kapat
                </Button>
                <Button
                  onClick={() => {
                    try {
                      // @ts-ignore
                      window.print?.();
                    } catch {}
                    setPrintOpen(false);
                  }}
                >
                  Yazdır
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Atama Modal */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ürün Paketleme Ataması</DialogTitle>
          </DialogHeader>
          {selectedUrun && (
            <div className="space-y-3">
              <p>
                <b>Ürün:</b> {selectedUrun.ad} ({selectedUrun.kod})
              </p>
              <p>
                <b>Kalan Adet:</b> {selectedUrun.kalan}
              </p>

              <Select
                onValueChange={(v: any) => {
                  setPaketTipi(v);
                  setSeciliKonteyner("");
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Paket Tipi Seç (Palet / Sandık)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="palet">Palet</SelectItem>
                  <SelectItem value="sandik">Sandık</SelectItem>
                </SelectContent>
              </Select>

              <Select
                disabled={!paketTipi}
                onValueChange={(v: any) => setSeciliKonteyner(v)}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      paketTipi ? "Mevcut seç veya Yeni Oluştur" : "Önce paket tipini seçin"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {mevcutListesi.map((p, i) => (
                    <SelectItem key={i} value={p.no}>
                      {p.no} - {p.tip}
                    </SelectItem>
                  ))}
                  <SelectItem value="yeni">Yeni Oluştur</SelectItem>
                </SelectContent>
              </Select>

              <Input
                placeholder="Dağıtılacak Adet"
                type="number"
                value={adet}
                onChange={(e) => setAdet(parseInt(e.target.value || "0", 10))}
              />

              {hata && <div className="text-red-600 text-sm">{hata}</div>}

              <div className="flex justify-end space-x-2">
                <Button variant="secondary" onClick={() => setShowModal(false)}>
                  İptal
                </Button>
                <Button variant="default" onClick={kaydetAtama}>
                  Kaydet
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}