"use client";

import { useEffect, useMemo, useState } from "react";
import arnikonLogo from "./logo.png";
import Image from "next/image";
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
import { Barcode } from "lucide-react";

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
  musteriAdi: string;
  istasyonAdi: string;
  paketleyenler: string[];
};

type UrunAtama = { no: string; adet: number; paketleyen?: string; kutuTipi?: string };

type Urun = {
  kod: string;
  ad: string;
  adet: number; // toplam
  tur: "Palet" | "Sandık" | string;
  atananlar: UrunAtama[]; // paket/palet bazında dağıtımlar
  kalan: number;
  istasyon?: string;
  birim?: string; // Adet, M, LT, vb.
  stokKodu?: string; // ERP stok kodu (yoksa kod kullanılır)
  adetText?: string; // Görsel amaçlı miktar metni (örn. 2*1)
  // Sevkiyat Depo miktarı (transfer sonrası)
  sevkiyatQty?: number;
  sevkiyatText?: string;
  sevkHazir?: boolean; // Transfer onaylandı mı?
};

type Konteyner = {
  no: string; // P001 / S002
  tip: "Palet" | "Sandık" | "Kutu" | "Poşet";
  siparis: string; // Sipariş no
  urunKodlari: string[]; // benzersiz ürün kodları
  adet: number; // konteynerdeki toplam adet
  durum: "Hazırlanıyor" | "Tamamlandı" | string;
  children?: string[]; // bağlı Kutu/Poşet numaraları
  sevkiyatYetkilisi?: string;
  aracTuru?: string;
  aracNo?: string;
  soforAdi?: string;
  paketYapilari?: string[]; // konteyner genelinde kullanılan kutu tipleri
  teslimAldi?: string;
  teslimTarihi?: string; // ISO date string
  teslimYeri?: string;
  teslimNotu?: string;
  teslimOnay?: boolean;
};

type PrintTarget =
  | { type: "order"; orderNo: string }
  | { type: "container"; containerNo: string }
  | { type: "station"; product: string }
  | { type: "shipmentGroup"; groupKey: string }
  | { type: "label"; product: string };

type Stage = "panel" | "sevkiyat" | "yukleme" | "saha";

const DEFAULT_SEVKIYAT_YETKILISI = "Mehmet KARAKAYA";
const ISTASYON_PAKETLEYEN: Record<string, string> = {
  "Depo": "Münür Mutlu",
  "Kesim Hane": "Mustafa Emre",
  "Boyahane": "Fahrettin Çakır",
  "Talaşlı İmalat": "Uğur Karakaşoğlu",
  "Montaj": "Zeki Olğaç",
  "Elektirikhane": "Elektrik Ekibi",
};
const ISTASYON_KOD: Record<string, string> = {
  "Depo": "DEP",
  "Kesim Hane": "KES",
  "Boyahane": "BOY",
  "Talaşlı İmalat": "TAL",
  "Montaj": "MON",
  "Elektirikhane": "ELK",
};
const PREFIX_TO_ISTASYON: Record<string, string> = Object.fromEntries(
  Object.entries(ISTASYON_KOD).map(([ad, kod]) => [kod, ad])
);

export default function PaketlemeTakipPaneli() {
  // `PREFIX_TO_ISTASYON` artık `useMemo` gerektirmiyor çünkü bileşen dışında tanımlandı.
  const [selectedSiparis, setSelectedSiparis] = useState<Siparis | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [selectedUrun, setSelectedUrun] = useState<Urun | null>(null);

  // Modal state
  const [paketTipi, setPaketTipi] = useState<"palet" | "sandik" | "kutu" | "poset" | "">("");
  const [seciliKonteyner, setSeciliKonteyner] = useState<string>(""); // mevcut no veya "yeni"
  const [adet, setAdet] = useState<number>(0);
  const [hata, setHata] = useState<string>("");

  // Badge edit state
  const [editPK, setEditPK] = useState<{ urunKod: string; paketNo: string } | null>(null);
  const [editQty, setEditQty] = useState<number>(0);

  const [seciliPaketleyen, setSeciliPaketleyen] = useState<string>("");
  const [seciliSevkiyatYetkilisi, setSeciliSevkiyatYetkilisi] = useState<string>(DEFAULT_SEVKIYAT_YETKILISI);
  const [paketYapisi, setPaketYapisi] = useState<string>("");

  // Sevkiyat transfer UI state
  const [transferTip, setTransferTip] = useState<"Palet" | "Sandık">("Palet");
  const [seciliKucuk, setSeciliKucuk] = useState<Record<string, boolean>>({});
  const [transferQuantities, setTransferQuantities] = useState<Record<string, number>>({});
  const [transferCounts, setTransferCounts] = useState<{ Kutu: number; Poşet: number }>({ Kutu: 0, Poşet: 0 });
  const [childrenHints, setChildrenHints] = useState<Record<string, string[]>>({});
  const [moveLog, setMoveLog] = useState<Record<string, Record<string, { child: string; qty: number }[]>>>({});
  const [capsuleArchive, setCapsuleArchive] = useState<Record<string, number>>({});
  const [sevkiyatModalOpen, setSevkiyatModalOpen] = useState(false);
  const [seciliKucukNo, setSeciliKucukNo] = useState<string | null>(null);
  const [sevkiyatTargetTip, setSevkiyatTargetTip] = useState<"Palet" | "Sandık">("Palet");
  const [sevkiyatTargetNo, setSevkiyatTargetNo] = useState<string>("");
  // Sevkiyat grouped assignment state
  const [sevkiyatGroup, setSevkiyatGroup] = useState<SevkGroup | null>(null);
  const [sevkiyatQty, setSevkiyatQty] = useState<number>(1);
  // Sevkiyat grouped popover temporary counter (key = `${groupKey}-${parentNo}`)
  const [groupEditCounts, setGroupEditCounts] = useState<Record<string, number>>({});
  // inline paketleme kaldırıldı, modal kullanılacak

  // Print Preview state
  const [printOpen, setPrintOpen] = useState(false);
  const [printTarget, setPrintTarget] = useState<PrintTarget | null>(null);
  const [packingListOpen, setPackingListOpen] = useState(false);
  const [qrMap, setQrMap] = useState<Record<string, string>>({}); // containerNo | order:<no> | <order>-<container>
  const [orderQR, setOrderQR] = useState<string>("");
  const [siparisAsama, setSiparisAsama] = useState<string>("Checklist Hazırlandı");

  const ARAC_TURLERI = ["Kamyon", "Tır", "Kamyonet", "Panelvan", "Forklift", "Diğer"];

  // Test modu: Sevkiyat tamamlanmadan yükleme alanına geçişe izin verir
  const [testMode, setTestMode] = useState<boolean>(false);
  // Opsiyonel: Montaj görselleri yüklendi bayrağı (süreç etiketi için)
  const [montajGorselleriYuklendi, setMontajGorselleriYuklendi] = useState<boolean>(false);
  // Sevkiyat Paketlemeye Geç butonu ile başlatılan süreç bayrağı
  const [sevkiyatBasladi, setSevkiyatBasladi] = useState<boolean>(false);
  // Yüklemeye Geç butonu ile başlatılan süreç bayrağı
  const [yuklemeBasladi, setYuklemeBasladi] = useState<boolean>(false);
  // Saha Montaj'a Geç butonu ile başlatılan süreç bayrağı
  const [sahaBasladi, setSahaBasladi] = useState<boolean>(false);

  // Yükleme alanına geçildiğinde otomatik "Kamyona Yüklendi" yapma — kullanıcı aksiyonu ile değişir

  // Uyarı popup
  const [alertOpen, setAlertOpen] = useState(false);
  const [alertMsg, setAlertMsg] = useState("");

  const updateContainer = (no: string, updates: Partial<Konteyner>) => {
    setPaletler(prev => prev.map(p => (p.no === no ? { ...p, ...updates } : p)));
  };
  const updateContainerExact = (no: string, tip: Konteyner["tip"], updates: Partial<Konteyner>) => {
    setPaletler(prev => prev.map(p => (p.no === no && p.tip === tip ? { ...p, ...updates } : p)));
  };

  // UI: Süreç aşaması (sekme)
  const [aktifAsama, setAktifAsama] = useState<Stage>("panel");

  const handleStageNavClick = (target: Stage) => {
    setAktifAsama(target);
  };
  // Saha Montaj / Depo geçici form state (containerNo -> fields)
  const [sahaEdits, setSahaEdits] = useState<Record<string, { teslimAldi?: string; teslimTarihi?: string; teslimYeri?: string; teslimNotu?: string }>>({});
  const getSahaField = (no: string, tip?: Konteyner["tip"]) => {
    const key = no;
    const fromState = sahaEdits[key] || {};
    const fromContainer = tip
      ? (paletler.find((p) => p.no === no && p.tip === tip) || null)
      : (paletMap.get(no) || null);
    return {
      teslimAldi: fromState.teslimAldi ?? (fromContainer?.teslimAldi ?? ""),
      teslimTarihi: fromState.teslimTarihi ?? (fromContainer?.teslimTarihi ?? ""),
      teslimYeri: fromState.teslimYeri ?? (fromContainer?.teslimYeri ?? ""),
      teslimNotu: fromState.teslimNotu ?? (fromContainer?.teslimNotu ?? ""),
    };
  };

  const isSahaValid = (no: string, tip?: Konteyner["tip"]) => {
    const f = getSahaField(no, tip);
    const hasName = !!(f.teslimAldi && f.teslimAldi.trim().length > 0);
    const hasDate = !!(f.teslimTarihi && f.teslimTarihi.trim().length > 0);
    return hasName && hasDate;
  };

  // Panelden doğrudan sevkiyata geçiş
  const handleGoToSevkiyat = () => {
    if (!selectedSiparis) return;
    setSevkiyatBasladi(true);
    setAktifAsama("sevkiyat");
  };

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
      musteriAdi: "Arnikon Müh A.Ş.",
      istasyonAdi: "Montaj",
      paketleyenler: [
        "Münür Mutlu", // Depo
        "Mustafa Emre", // Kesim Hane
        "Fahrettin Çakır", // Boyahane
        "Uğur Karakaşoğlu", // Talaşlı İmalat
        "Zeki Olğaç", // Montaj
      ],
    },
  ];

  const packingListData = {
    orderNo: selectedSiparis?.no || siparisler[0]?.no || "",
    invoiceNo: "ARN202500000086",
    date: "08.10.2025",
    supplier: {
      companyName: "ARNIKON CRANE TECHNIQUE DIS TICARET ANONIM SIRKETI",
      address: "ISTIKLAL OSB MAH. FATIH CAD. NO:9/1",
      city: "CUMRA / KONYA",
      country: "TÜRKİYE",
      phone: "0090 444 2 540",
      fax: "0090 332 342 7009",
      email: "info@arnikon.com.tr",
    },
    consignee: {
      companyName: "UTA METAUX",
      address: "RTE DE GABES KM 5",
      city: "SFAX",
      country: "TUNISIA",
      phone: "00216 74 665 453",
      email: "contact.utametaux@gmail.com",
    },
    items: [
      { no: 1, description: "3,2 TON MONORAIL HOIST", unit: "PC", qty: 1, dimensions: "", packingType: "WOODEN BOX", unitWeight: 600, totalWeight: 600 },
      { no: 2, description: "3,2 TON ENDCARRIAGES", unit: "SET", qty: 1, dimensions: "", packingType: "PALETTE", unitWeight: 200, totalWeight: 200 },
      { no: 3, description: "C PROFILE", unit: "SET", qty: 1, dimensions: "", packingType: "OPEN", unitWeight: 80, totalWeight: 80 },
      { no: 4, description: "CABLE", unit: "SET", qty: 1, dimensions: "", packingType: "PALETTE", unitWeight: 70, totalWeight: 70 },
      { no: 5, description: "CABLE", unit: "SET", qty: 1, dimensions: "", packingType: "REEL", unitWeight: 150, totalWeight: 150 },
    ],
    totalText: "One Thousand One Hundred Kilogram",
    netWeight: 1000,
    grossWeight: 1100,
    vessel: "DIONYSSIS A / LTS41525",
    portLoading: "MARPORT/AMBARLI",
    portDischarge: "SFAX",
  };
  const formatWeight = (value: number) =>
    value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const formatQty = (value: number) =>
    value.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const packingListTotalWeight = packingListData.items.reduce((sum, item) => sum + item.totalWeight, 0);

  const [urunler, setUrunler] = useState<Urun[]>([
    // 1
    {
      kod: "PRD-0001",
      stokKodu: "152.01.01.25118",
      ad: "VDH16_Red.I -",
      adet: 1,
      adetText: "1",
      tur: "Palet",
      atananlar: [],
      kalan: 1,
      sevkiyatQty: 0,
      sevkiyatText: "0",
      istasyon: "Montaj",
      birim: "Adet",
    },
    // 2
    {
      kod: "PRD-0002",
      stokKodu: "152.05.01.22747",
      ad: "ÇKK_D250_1,5KW_RED.I -",
      adet: 2,
      adetText: "2",
      tur: "Palet",
      atananlar: [],
      kalan: 2,
      sevkiyatQty: 1,
      sevkiyatText: "1",
      istasyon: "Montaj",
      birim: "Adet",
    },
    // 3
    {
      kod: "PRD-0003",
      stokKodu: "151.29.01.26575",
      ad: "KY ÇKK D250 - KÖPRÜ SON MONTAJ BAĞLANTI ELEMANLARI -",
      adet: 2,
      adetText: "2",
      tur: "Kutu",
      atananlar: [],
      kalan: 2,
      sevkiyatQty: 2,
      sevkiyatText: "2",
      istasyon: "Depo",
      birim: "Adet",
    },
    // 4
    {
      kod: "PRD-0004",
      stokKodu: "151.31.03.26579",
      ad: "25428 - 16 TON - KÖPRÜ GRUBU -",
      adet: 1,
      adetText: "1",
      tur: "Palet",
      atananlar: [],
      kalan: 1,
      sevkiyatQty: 1,
      sevkiyatText: "1",
      istasyon: "Boyahane",
      birim: "Adet",
    },
    // 5
    {
      kod: "PRD-0005",
      stokKodu: "151.23.04.26612",
      ad: "25428 - HOLBOYU KAPALI BARA TESİSATI -",
      adet: 1,
      adetText: "1",
      tur: "Kutu",
      atananlar: [],
      kalan: 1,
      sevkiyatQty: 1,
      sevkiyatText: "1",
      istasyon: "Depo",
      birim: "Adet",
    },
    // 6
    {
      kod: "PRD-0006",
      stokKodu: "151.23.03.26610",
      ad: "25428 - KÖPRÜ ÇİFT C PROFİL TESİSATI -",
      adet: 1,
      adetText: "1",
      tur: "Kutu",
      atananlar: [],
      kalan: 1,
      sevkiyatQty: 1,
      sevkiyatText: "1",
      istasyon: "Depo",
      birim: "Adet",
    },
    // 7
    {
      kod: "PRD-0007",
      stokKodu: "151.23.05.26615",
      ad: "25428 - KÖPRÜ KARE BUAT GRUBU -",
      adet: 1,
      adetText: "1",
      tur: "Kutu",
      atananlar: [],
      kalan: 1,
      sevkiyatQty: 1,
      sevkiyatText: "1",
      istasyon: "Elektirikhane",
      birim: "Adet",
    },
    // 8
    {
      kod: "PRD-0008",
      stokKodu: "151.23.03.26617",
      ad: "25428 - KÖPRÜ TESİSAT KABLO GRUBU -",
      adet: 1,
      adetText: "1",
      tur: "Kutu",
      atananlar: [],
      kalan: 1,
      sevkiyatQty: 1,
      sevkiyatText: "1",
      istasyon: "Elektirikhane",
      birim: "Adet",
    },
    // 9
    {
      kod: "PRD-0009",
      stokKodu: "151.20.01.20524",
      ad: "VDH SIYIRICI GRUBU -",
      adet: 1,
      adetText: "1",
      tur: "Kutu",
      atananlar: [],
      kalan: 1,
      sevkiyatQty: 1,
      sevkiyatText: "1",
      istasyon: "Elektirikhane",
      birim: "Adet",
    },
    // 10
    {
      kod: "PRD-0010",
      stokKodu: "151.20.01.20525",
      ad: "KY SIYIRICI GRUBU -",
      adet: 1,
      adetText: "1",
      tur: "Kutu",
      atananlar: [],
      kalan: 1,
      sevkiyatQty: 1,
      sevkiyatText: "1",
      istasyon: "Elektirikhane",
      birim: "Adet",
    },
    // 11
    {
      kod: "PRD-0011",
      stokKodu: "150.01.04.26633",
      ad: "RÖTUŞ BOYA -",
      adet: 5,
      adetText: "5",
      tur: "Kutu",
      atananlar: [],
      kalan: 5,
      sevkiyatQty: 5,
      sevkiyatText: "5",
      istasyon: "Boyahane",
      birim: "LT",
    },
    // 12 (aynı stok kodu ikinci satır)
    {
      kod: "PRD-0012",
      stokKodu: "150.01.04.26633",
      ad: "RÖTUŞ BOYA -",
      adet: 5,
      adetText: "5",
      tur: "Kutu",
      atananlar: [],
      kalan: 5,
      sevkiyatQty: 5,
      sevkiyatText: "5",
      istasyon: "Boyahane",
      birim: "LT",
    },
  ]);

  const tumUrunlerTamamlandi = useMemo(() => urunler.every((u) => u.kalan === 0), [urunler]);

  const [paletler, setPaletler] = useState<Konteyner[]>([]);

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

  // Sevkiyat paketleme görünümü için ürün satırları
  // Bu fonksiyon, bileşen dışında bir `utils.ts` dosyasına taşınabilir.
  // Daha okunabilir ve sağlam hale getirilmiştir.
const parseQtyText = (text?: string | number): number => {
  if (text === undefined || text === null) return 0;
  if (typeof text === 'number') return text;

  const s = String(text).trim();
  if (!s) return 0;

  if (s.includes('*')) {
    return s.split('*')
      .map(part => parseFloat(part.trim().replace(',', '.')))
      .filter(num => !isNaN(num))
      .reduce((acc, val) => acc * val, 1);
  }

  const num = parseFloat(s.replace(',', '.'));
  return isNaN(num) ? 0 : num;
};

  const getLastPaketleyen = (u: Urun): string | undefined => {
    for (let i = u.atananlar.length - 1; i >= 0; i -= 1) {
      const p = u.atananlar[i].paketleyen;
      if (p) return p;
    }
    return undefined;
  };

  const getLastBoxType = (u: Urun): string | undefined => {
    for (let i = u.atananlar.length - 1; i >= 0; i -= 1) {
      const t = u.atananlar[i].kutuTipi;
      if (t) return t;
    }
    return undefined;
  };

  const getLastParentContainer = (u: Urun): { no: string; tip: string } | undefined => {
    // 1) Doğrudan Palet/Sandık ataması var mı?
    for (let i = u.atananlar.length - 1; i >= 0; i -= 1) {
      const a = u.atananlar[i];
      const c = paletMap.get(a.no);
      if (c && (c.tip === 'Palet' || c.tip === 'Sandık')) return { no: c.no, tip: c.tip };
    }
    // 2) Kutu/Poşet üzerinden parent bul
    for (let i = u.atananlar.length - 1; i >= 0; i -= 1) {
      const a = u.atananlar[i];
      const c = paletMap.get(a.no);
      if (c && (c.tip === 'Kutu' || c.tip === 'Poşet')) {
        const parentNo = getChildParent(a.no);
        if (parentNo) {
          const parent = paletMap.get(parentNo);
          if (parent && (parent.tip === 'Palet' || parent.tip === 'Sandık')) {
            return { no: parent.no, tip: parent.tip };
          }
        }
      }
    }
    return undefined;
  };

  const isPackagingReady = (u: Urun) => {
    const prod = parseQtyText(u.adetText ?? u.adet);
    const sevk = parseQtyText(u.sevkiyatText ?? u.sevkiyatQty ?? 0);
    // Transfer onayı sonrası ve sevk depo miktarı üretim miktarını karşılıyorsa paketleme aktif
    return !!u.sevkHazir && sevk >= prod && prod > 0;
  };

  const sevkiyatUrunRows = useMemo(() => {
    return urunler.map(u => {
      const sevkNum = parseQtyText(u.sevkiyatText ?? u.sevkiyatQty ?? 0);
      const prodNum = parseQtyText(u.adetText ?? u.adet ?? 0);
      // Öncelik: Palet no, yoksa Sandık no; son çare Kutu/Poşet -> parent
      const paketNo = (() => {
        const parent = getLastParentContainer(u);
        if (parent) return parent.no;
        return '';
      })();

      return ({
        key: u.kod,
        stokKodu: u.stokKodu || u.kod,
        ad: u.ad,
        istasyon: u.istasyon || "-",
        miktar: u.adetText ?? String(u.adet ?? 0),
        birim: u.birim || "Adet",
        sevk: u.sevkiyatText ?? String(u.sevkiyatQty ?? 0),
        paketNo: paketNo || '',
        ready: isPackagingReady(u),
        // Sevk < Üretim: her iki buton da pasif. Transfer yalnızca sevk>=üretim ve henüz onaylanmamışsa aktif.
        canTransfer: sevkNum >= prodNum && !u.sevkHazir,
        done: !!u.sevkHazir && sevkNum === 0,
        ref: u,
      });
    });
  }, [urunler, paletMap]);

  const urunMap = useMemo(() => {
    const map = new Map<string, Urun>();
    for (const u of urunler) map.set(u.kod, u);
    return map;
  }, [urunler]);

  // Sevkiyat transfer: istasyondan gelen küçük paketler (Kutu/Poşet)
  const istasyonKapsulleri = useMemo(() => paletlerFlat.filter(p => p.tip === "Kutu" || p.tip === "Poşet"), [paletlerFlat]);
  // Küçük paket seçimini değiştir
  const toggleKucukSecim = (no: string) => {
    setSeciliKucuk(prev => ({ ...prev, [no]: !prev[no] }));
  };
  const selectedNos = useMemo(() => Object.entries(seciliKucuk).filter(([_, v]) => v).map(([k]) => k), [seciliKucuk]);
  const selectedSummary = useMemo(() => {
    const sum: Record<string, { kod: string; ad: string; adet: number }> = {};
    for (const u of urunler) {
      let total = 0;
      for (const a of u.atananlar) if (selectedNos.includes(a.no)) total += a.adet;
      if (total > 0) sum[u.kod] = { kod: u.kod, ad: u.ad, adet: total };
    }
    return sum;
  }, [urunler, selectedNos]);

  const selectedByType = useMemo(() => {
    const map: { Kutu: string[]; Poşet: string[] } = { Kutu: [], Poşet: [] };
    for (const no of selectedNos) {
      const t = paletMap.get(no)?.tip;
      if (t === 'Kutu' || t === 'Poşet') map[t].push(no);
    }
    return map;
  }, [selectedNos, paletMap]);

  useEffect(() => {
    setTransferCounts({ Kutu: selectedByType.Kutu.length, Poşet: selectedByType.Poşet.length });
  }, [selectedByType]);

  // Sevk Depo miktarlarını üretim depo miktarına eşitle (başlangıçta). Sıfır olmasın.
  useEffect(() => {
    setUrunler((prev) => {
      let changed = false;
      const next = prev.map((u) => {
        const prod = parseQtyText(u.adetText ?? u.adet ?? 0);
        const sevk = parseQtyText(u.sevkiyatText ?? u.sevkiyatQty ?? 0);
        const target = prod > 0 ? prod : sevk;
        if (target > 0 && sevk !== target) {
          changed = true;
          return { ...u, sevkiyatQty: target, sevkiyatText: String(target) };
        }
        return u;
      });
      return changed ? next : prev;
    });
    // sadece ilk yüklemede
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setCapsuleArchive((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const c of paletler) {
        if ((c.tip === "Kutu" || c.tip === "Poşet") && c.adet > 0) {
          if (next[c.no] !== c.adet) {
            next[c.no] = c.adet;
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [paletler]);

  const recordCapsuleTotals = (moves: Record<string, { child: string; qty: number }[]>) => {
    const totals = new Map<string, number>();
    for (const arr of Object.values(moves)) {
      for (const { child, qty } of arr) {
        totals.set(child, (totals.get(child) || 0) + qty);
      }
    }
    if (totals.size === 0) return;
    setCapsuleArchive((prev) => {
      let changed = false;
      const next = { ...prev };
      totals.forEach((qty, child) => {
        if (qty > 0) {
          const current = next[child] ?? 0;
          const normalized = Math.max(current, qty);
          if (normalized !== current) {
            next[child] = normalized;
            changed = true;
          }
        }
      });
      return changed ? next : prev;
    });
  };

  // --- Sevkiyat: Kutu/Poşet grupları (Sipariş+İstasyonPrefix+Tip) ---
  const parseStationAndType = (no: string) => {
    // examples: KES-P001, DEP-K002
    const [prefix, rest] = no.includes('-') ? no.split('-') : ["", no];
    const tip = rest.startsWith('K') ? 'Kutu' : rest.startsWith('P') ? 'Poşet' : '';
    return { prefix, tip } as { prefix: string; tip: 'Kutu' | 'Poşet' | '' };
  };

  type SevkGroup = {
    key: string;            // `${siparis}-${prefix}-${tip}`
    siparis: string;
    prefix: string;         // KES, DEP, MON...
    tip: 'Kutu' | 'Poşet';
    paketNoSummary: string; // e.g. `KES-K*` / `KES-P*`
    children: string[];     // kapsül ID listesi (KES-K001, ...)
    kiad: number;           // toplam ürün adedi (kutu içi toplam)
    adet: number;           // kapsül sayısı
    assignedMap: Record<string, number>; // { P001: 2, S003: 1 }
    assignedCount: number;  // atanmış kapsül sayısı (sum of assignedMap)
    kalan: number;          // adet - assignedCount
    tamamlandi: boolean;    // kalan === 0
  };

  const sevkiyatGruplari: SevkGroup[] = useMemo(() => {
    const allSmall = paletler.filter(p => (p.tip === 'Kutu' || p.tip === 'Poşet') && p.siparis === (selectedSiparis?.no || siparisler[0].no));
    const byKey = new Map<string, SevkGroup>();

    // Index: hangi küçük kapsül hangi palet/sandık altında?
    const parentByChild = new Map<string, string>();
    for (const c of paletler) {
      if (c.tip === 'Palet' || c.tip === 'Sandık') {
        for (const ch of c.children || []) parentByChild.set(ch, c.no);
      }
    }
    // Merge in childrenHints (pending or recently-added children)
    for (const [parent, kids] of Object.entries(childrenHints)) {
      const p = paletMap.get(parent);
      if (p && (p.tip === 'Palet' || p.tip === 'Sandık')) {
        for (const ch of kids) parentByChild.set(ch, parent);
      }
    }

    const movedByChild = new Map<string, number>();
    for (const moves of Object.values(moveLog)) {
      for (const entries of Object.values(moves)) {
        for (const entry of entries) {
          movedByChild.set(entry.child, (movedByChild.get(entry.child) || 0) + entry.qty);
        }
      }
    }

    for (const k of allSmall) {
      const { prefix, tip } = parseStationAndType(k.no);
      if (!prefix || !tip) continue;
      const key = `${selectedSiparis?.no || siparisler[0].no}-${prefix}-${tip}`;
      if (!byKey.has(key)) byKey.set(key, {
        key,
        siparis: selectedSiparis?.no || siparisler[0].no,
        prefix,
        tip: tip as ('Kutu'|'Poşet'),
        paketNoSummary: `${prefix}-${tip === 'Kutu' ? 'K*' : 'P*'}`,
        children: [],
        kiad: 0,
        adet: 0,
        assignedMap: {},
        assignedCount: 0,
        kalan: 0,
        tamamlandi: false,
      });
      const g = byKey.get(key)!;
      g.children.push(k.no);
      g.adet += 1;
      // kapsül içindeki ürün toplamı
      const currentQty = getContainerLines(k.no).reduce((s, r) => s + r.adet, 0);
      const movedQty = movedByChild.get(k.no) || 0;
      let inside = currentQty + movedQty;
      if (inside === 0) {
        const fallback = paletMap.get(k.no)?.adet ?? 0;
        if (fallback > 0) inside = fallback;
        const archived = capsuleArchive[k.no];
        if (inside === 0 && archived && archived > 0) inside = archived;
      }
      g.kiad += inside;
      // atanmış mı?
      const parent = parentByChild.get(k.no);
      if (parent) {
        g.assignedMap[parent] = (g.assignedMap[parent] || 0) + 1;
        g.assignedCount += 1;
      }
    }

    for (const g of byKey.values()) {
      g.kalan = Math.max(0, g.adet - g.assignedCount);
      g.tamamlandi = g.kalan === 0 && g.adet > 0;
    }
    return Array.from(byKey.values());
  }, [paletler, selectedSiparis, urunler, childrenHints, paletMap, moveLog, capsuleArchive]);

  const paletSandiklar = useMemo(
    () => paletler.filter((p) => p.tip === "Palet" || p.tip === "Sandık"),
    [paletler]
  );

  const paletTipSayilari = useMemo(() => {
    const counts: Record<string, number> = { Palet: 0, Sandık: 0 };
    for (const p of paletSandiklar) {
      if (p.tip === "Palet" || p.tip === "Sandık") {
        counts[p.tip] = (counts[p.tip] || 0) + 1;
      }
    }
    return counts;
  }, [paletSandiklar]);

  // Sevkiyat paketleme tamamlandı mı? Tüm ürünlerde sevk onayı var ve sevk miktarı 0 olmalı
  const sevkiyatSatirTamam = useMemo(() => {
    return urunler.every(u => {
      const prod = parseQtyText(u.adetText ?? u.adet);
      const sevk = parseQtyText(u.sevkiyatText ?? u.sevkiyatQty ?? 0);
      if (prod <= 0) return true; // üretim yoksa sorun yok
      return !!u.sevkHazir && sevk === 0;
    });
  }, [urunler]);

  const sevkiyatTamamlandi = useMemo(() => {
    if (!sevkiyatSatirTamam) return false;
    if (paletSandiklar.length === 0) return false;
    const hasContent = paletSandiklar.some((p) => p.adet > 0);
    return hasContent;
  }, [sevkiyatSatirTamam, paletSandiklar]);

  const yuklemeTamamlandi = useMemo(
    () => paletSandiklar.every((p) => p.durum === "Kamyona Yüklendi"),
    [paletSandiklar]
  );

  // Saha teslim tamam: tüm palet/sandık teslim onaylı ve durum "Teslim Edildi"
  const sahaTeslimTamamlandi = useMemo(
    () => paletSandiklar.length > 0 && paletSandiklar.every((p) => p.durum === "Teslim Edildi" && !!p.teslimOnay),
    [paletSandiklar]
  );

  useEffect(() => {
    if (sahaTeslimTamamlandi) {
      setSiparisAsama("Saha Teslim Tamamlandı");
      return;
    }
    if (yuklemeTamamlandi) {
      setSiparisAsama("Araca Yüklendi");
      return;
    }
    if (sevkiyatTamamlandi) {
      setSiparisAsama("Sevkiyat Paketleme Tamamlandı");
      return;
    }
    if (tumUrunlerTamamlandi) {
      setSiparisAsama("Ürün Hazırlık Tamamlandı");
      return;
    }
    setSiparisAsama("Checklist Hazırlandı");
  }, [tumUrunlerTamamlandi, sevkiyatTamamlandi, yuklemeTamamlandi, sahaTeslimTamamlandi]);

  // --- Süreç (Paketleme Takip Paneli) göstergesi ---
  const getSurecLabel = (): { text: string; tone: 'gray' | 'blue' | 'amber' | 'violet' | 'green' } => {
    // Duruma göre ilerleyen süreç etiketi (sekmeden bağımsız)
    if (montajGorselleriYuklendi) return { text: 'Montaj Tamamlandı', tone: 'green' };
    const anyDelivered = paletSandiklar.some(p => p.teslimOnay || p.durum === 'Teslim Edildi');
    if (sahaBasladi || anyDelivered) return { text: 'Saha Montaj', tone: 'violet' };
    const anyLoaded = paletSandiklar.some(p => p.durum === 'Kamyona Yüklendi');
    if (yuklemeBasladi || anyLoaded) return { text: 'Yüklemede', tone: 'amber' };
    const hasPackagingActivity = paletler.length > 0 || urunler.some(u => u.atananlar.length > 0);
    if (sevkiyatBasladi || hasPackagingActivity) return { text: 'Paketlemede', tone: 'blue' };
    // Varsayılan: Cheklist Hazır
    return { text: 'Cheklist Hazır', tone: 'gray' };
  };
  // --- Action gating helpers (aksiyon kilidi) ---
  const canSevkiyatActions = true; // süreç burada başlıyor, aksiyon serbest
  const canYuklemeActions = testMode || sevkiyatTamamlandi;
  const canSahaActions = testMode || yuklemeTamamlandi;

  const openSevkiyatAta = (no: string) => {
    setSeciliKucukNo(no);
    setSevkiyatTargetTip("Palet");
    setSevkiyatTargetNo("");
    setHata("");
    setSevkiyatModalOpen(true);
  };

  const openStationPrint = (urun: Urun) => {
    setPrintTarget({ type: "station", product: urun.kod });
    setPrintOpen(true);
  };

  const openShipmentGroupPrint = (groupKey: string) => {
    setPrintTarget({ type: "shipmentGroup", groupKey });
    setPrintOpen(true);
  };

// İstasyondan seçilen küçükleri sevkiyat konteynerine aktar
const transferIstasyondanSevkiyata = () => {
  const secilenNos = selectedNos;
  if (secilenNos.length === 0) { setHata("Aktarmak için en az bir kutu/poşet seçin."); return; }

  // Kaç poşet, kaç kutu aktaracağız?
  const posetList = selectedByType.Poşet.slice(0, transferCounts.Poşet || 0);
  const kutuList = selectedByType.Kutu.slice(0, transferCounts.Kutu || 0);
  const chosen = Array.from(new Set([...posetList, ...kutuList]));
  if (chosen.length === 0) { setHata("Aktarılacak paket adedi 0 olamaz."); return; }

  const hedefNo = nextCode(transferTip);
  setChildrenHints(prev => ({ ...prev, [hedefNo]: chosen }));
  setPaletler(prev => ([...prev, {
    no: hedefNo,
    tip: transferTip,
    siparis: selectedSiparis?.no || siparisler[0].no,
    urunKodlari: [],
    adet: 0,
    durum: "Hazırlanıyor",
    sevkiyatYetkilisi: seciliSevkiyatYetkilisi || undefined,
    children: chosen,
  }]));

  // Hareket günlüğü: ürün bazlı, çocuk kutu/poşet ve miktarları logla
  const productChildMoves: Record<string, { child: string; qty: number }[]> = {};

  // Ürünlerde, seçilen küçük paketlerdeki TÜM miktarları hedef konteynere taşı
  setUrunler(prev => {
    const yeni = prev.map(u => {
      let moved = 0;
      const nextAt: UrunAtama[] = [];
      for (const a of u.atananlar) {
        if (chosen.includes(a.no)) {
          // Logla: hangi ürün, hangi çocuk, kaç adet
          if (!productChildMoves[u.kod]) productChildMoves[u.kod] = [];
          productChildMoves[u.kod].push({ child: a.no, qty: a.adet });
          moved += a.adet; // bu küçük paketteki tüm adetler taşınır
        } else {
          nextAt.push(a);
        }
      }
      if (moved > 0) {
        const idx = nextAt.findIndex(a => a.no === hedefNo);
        if (idx === -1) nextAt.push({ no: hedefNo, adet: moved, paketleyen: seciliPaketleyen || undefined });
        else nextAt[idx] = { ...nextAt[idx], adet: nextAt[idx].adet + moved };
      }
      const yeniKalan = u.adet - nextAt.reduce((s, a) => s + a.adet, 0);
      return { ...u, atananlar: nextAt, kalan: yeniKalan };
    });
    recomputeContainersFromUrunler(yeni);
    return yeni;
  });

  // Hareket günlüğünü kaydet
  setMoveLog(prev => ({ ...prev, [hedefNo]: productChildMoves }));
  recordCapsuleTotals(productChildMoves);

  // Temizlik
  setSeciliKucuk({});
  setTransferQuantities({});
  setTransferCounts({ Kutu: 0, Poşet: 0 });
};

  const commitSevkiyatAta = () => {
    if (!seciliKucukNo) return;
    const hedefNo = sevkiyatTargetNo === "yeni" ? nextCode(sevkiyatTargetTip) : sevkiyatTargetNo;
    if (!hedefNo) { setHata("Hedef palet/sandık seçin."); return; }

    if (sevkiyatTargetNo === "yeni") {
      setPaletler(prev => ([...prev, {
        no: hedefNo,
        tip: sevkiyatTargetTip,
        siparis: selectedSiparis?.no || siparisler[0].no,
        urunKodlari: [],
        adet: 0,
        durum: "Hazırlanıyor",
        sevkiyatYetkilisi: seciliSevkiyatYetkilisi || undefined,
        children: [seciliKucukNo],
      }]));
    } else {
      setPaletler(prev => prev.map(p => p.no === hedefNo
        ? { ...p, children: Array.from(new Set([...(p.children || []), seciliKucukNo])) }
        : p
      ));
    }
    setChildrenHints(prev => ({ ...prev, [hedefNo]: Array.from(new Set([...(prev[hedefNo] || []), seciliKucukNo])) }));

    const productChildMoves: Record<string, { child: string; qty: number }[]> = {};

    setUrunler(prev => {
      const yeni = prev.map(u => {
        let moved = 0;
        const nextAt: UrunAtama[] = [];
        for (const a of u.atananlar) {
          if (a.no === seciliKucukNo) {
            if (!productChildMoves[u.kod]) productChildMoves[u.kod] = [];
            productChildMoves[u.kod].push({ child: seciliKucukNo, qty: a.adet });
            moved += a.adet;
          } else {
            nextAt.push(a);
          }
        }
        if (moved > 0) {
          const idx = nextAt.findIndex(a => a.no === hedefNo);
          if (idx === -1) nextAt.push({ no: hedefNo, adet: moved });
          else nextAt[idx] = { ...nextAt[idx], adet: nextAt[idx].adet + moved };
        }
        const yeniKalan = u.adet - nextAt.reduce((s, a) => s + a.adet, 0);
        return { ...u, atananlar: nextAt, kalan: yeniKalan };
      });
      recomputeContainersFromUrunler(yeni);
      return yeni;
    });

    setMoveLog(prev => ({
      ...prev,
      [hedefNo]: {
        ...(prev[hedefNo] || {}),
        ...Object.fromEntries(Object.entries(productChildMoves).map(([k, v]) => [k, [ ...(prev[hedefNo]?.[k] || []), ...v ]]))
      }
    }));
    recordCapsuleTotals(productChildMoves);

    setSevkiyatModalOpen(false);
    setSeciliKucukNo(null);
  };

  // Sevkiyat grouped assignment submit handler (moved inside component)
  const commitSevkiyatAtaGroup = () => {
    if (!sevkiyatGroup) return;

    const hedefNo =
      sevkiyatTargetNo === "yeni"
        ? nextCode(sevkiyatTargetTip)
        : sevkiyatTargetNo;

    if (!hedefNo) {
      setHata("Hedef palet/sandık seçin.");
      return;
    }

    // Hedef konteyner yoksa oluştur
    if (sevkiyatTargetNo === "yeni") {
      setPaletler((prev) => [
        ...prev,
        {
          no: hedefNo,
          tip: sevkiyatTargetTip,
          siparis: selectedSiparis?.no || siparisler[0].no,
          urunKodlari: [],
          adet: 0,
          durum: "Hazırlanıyor",
          sevkiyatYetkilisi: seciliSevkiyatYetkilisi || undefined,
          children: [],
        },
      ]);
    }

    // Halihazırda atanmış küçük paketleri (kutu/poşet) çıkar
    const alreadyAssigned = new Set<string>();
    for (const p of paletler) {
      if (p.tip === "Palet" || p.tip === "Sandık") {
        for (const ch of p.children || []) alreadyAssigned.add(ch);
      }
    }

    // Bu gruptan atanabilecek maksimum adet kadar çocuk seç
    const available = sevkiyatGroup.children
      .filter((ch) => !alreadyAssigned.has(ch))
      .slice(0, Math.max(1, Math.min(sevkiyatGroup.kalan, sevkiyatQty)));

    if (available.length === 0) {
      setHata("Atanacak uygun kapsül yok.");
      return;
    }

    // Seçilen çocukları hedef konteynere ekle
    setPaletler((prev) =>
      prev.map((p) =>
        p.no === hedefNo
          ? { ...p, children: Array.from(new Set([...(p.children || []), ...available])) }
          : p
      )
    );
    // Merge available children into childrenHints for the target container
    setChildrenHints(prev => ({
      ...prev,
      [hedefNo]: Array.from(new Set([...(prev[hedefNo] || []), ...available]))
    }));

    // Ürün adetlerini çocuklardan hedef konteynere taşı
    const productChildMoves: Record<string, { child: string; qty: number }[]> = {};
    setUrunler((prev) => {
      const yeni = prev.map((u) => {
        let movedByUrun = 0;
        const rest: UrunAtama[] = [];

        for (const a of u.atananlar) {
          if (available.includes(a.no)) {
            if (!productChildMoves[u.kod]) productChildMoves[u.kod] = [];
            productChildMoves[u.kod].push({ child: a.no, qty: a.adet });
            movedByUrun += a.adet;
          } else {
            rest.push(a);
          }
        }

        if (movedByUrun > 0) {
          const idx = rest.findIndex((a) => a.no === hedefNo);
          if (idx === -1) rest.push({ no: hedefNo, adet: movedByUrun });
          else rest[idx] = { ...rest[idx], adet: rest[idx].adet + movedByUrun };
        }

        const yeniKalan = u.adet - rest.reduce((s, a) => s + a.adet, 0);
        return { ...u, atananlar: rest, kalan: yeniKalan };
      });

      recomputeContainersFromUrunler(yeni);
      return yeni;
    });

    // Hareket günlüğünü birleştir
    setMoveLog((prev) => ({
      ...prev,
      [hedefNo]: {
        ...(prev[hedefNo] || {}),
        ...Object.fromEntries(
          Object.entries(productChildMoves).map(([k, v]) => [
            k,
            [...(prev[hedefNo]?.[k] || []), ...v],
          ])
        ),
      },
    }));
    recordCapsuleTotals(productChildMoves);

    setSevkiyatModalOpen(false);
    setSevkiyatGroup(null);
    setSevkiyatQty(1);
  };

  const mevcutListesi = useMemo(() => {
    if (!paketTipi) return [] as Konteyner[];
    const tipLabel = paketTipi === "palet" ? "Palet"
      : paketTipi === "sandik" ? "Sandık"
      : paketTipi === "kutu" ? "Kutu"
      : paketTipi === "poset" ? "Poşet" : "";
    return tipLabel ? paletlerFlat.filter((p) => p.tip === tipLabel) : [];
  }, [paketTipi, paletlerFlat]);

  // ----- helpers -----

  const getAssignedTypesForProduct = (urun: Urun) => {
    const set = new Set<string>();
    for (const a of urun.atananlar) {
      const c = paletMap.get(a.no);
      if (c) set.add(c.tip);
    }
    return Array.from(set);
  };

  const isPaletSandik = (no: string) => {
    const t = paletMap.get(no)?.tip;
    return t === "Palet" || t === "Sandık";
  };

  const getPSTypesForProduct = (u: Urun) => {
    const types = new Set<string>();
    for (const a of u.atananlar) {
      if (!isPaletSandik(a.no)) continue;
      const t = paletMap.get(a.no)?.tip;
      if (t) types.add(t);
    }
    return Array.from(types);
  };

  const getPSAssignments = (u: Urun) => u.atananlar.filter(a => isPaletSandik(a.no));
  const handleAtaClick = (urun: Urun) => {
    setSelectedUrun(urun);
    setPaketTipi("");
    setSeciliKonteyner("");
    setAdet(urun.kalan);
    setHata("");
    const defaultPaketleyen = urun.istasyon ? (ISTASYON_PAKETLEYEN[urun.istasyon] || "") : "";
    setSeciliPaketleyen(defaultPaketleyen);
    setSeciliSevkiyatYetkilisi(DEFAULT_SEVKIYAT_YETKILISI);
    setShowModal(true);
  };

  const nextCode = (tip: "Palet" | "Sandık" | "Kutu" | "Poşet") => {
    const prefix = tip === "Palet" ? "P" : tip === "Sandık" ? "S" : tip === "Kutu" ? "K" : "P"; // Poşet -> P
    const nums = paletler
      .filter((p) => p.tip === tip)
      .map((p) => parseInt(p.no.replace(/\D/g, ""), 10))
      .filter((n) => !isNaN(n));
    const max = nums.length ? Math.max(...nums) : 0;
    const next = String(max + 1).padStart(3, "0");
    return `${prefix}${next}`;
  };

  const nextStationCode = (tip: "Kutu" | "Poşet", istasyon?: string) => {
    const sk = istasyon ? ISTASYON_KOD[istasyon] : undefined;
    const localPrefix = tip === "Kutu" ? "K" : "P";
    if (!sk) return `${localPrefix}${String( (paletler.filter(p => p.tip===tip).length) + 1 ).padStart(3, "0")}`;
    const pattern = `${sk}-${localPrefix}`;
    const nums = paletler
      .filter(p => p.tip === tip && p.no.startsWith(pattern))
      .map(p => parseInt(p.no.replace(/\D/g, ''), 10))
      .filter(n => !isNaN(n));
    const max = nums.length ? Math.max(...nums) : 0;
    return `${sk}-${localPrefix}${String(max + 1).padStart(3, '0')}`;
  };

  function getContainerLines(no: string) {
    const lines: { kod: string; ad: string; adet: number; kutuTipi?: string }[] = [];
    for (const u of urunler) {
      const found = u.atananlar.find((a) => a.no === no);
      if (found) lines.push({ kod: u.stokKodu || u.kod, ad: u.ad, adet: found.adet, kutuTipi: found.kutuTipi });
    }
    return lines;
  }

  const getOrderContainers = (orderNo: string) => paletler.filter((p) => p.siparis === orderNo);

  const getOrderItemSummary = (orderNo: string) => {
    const containers = new Set(getOrderContainers(orderNo).map((c) => c.no));
    const map = new Map<string, { kod: string; ad: string; adet: number }>();
    for (const u of urunler) {
      let sum = 0;
      for (const a of u.atananlar) if (containers.has(a.no)) sum += a.adet;
      if (sum > 0) map.set(u.kod, { kod: u.stokKodu || u.kod, ad: u.ad, adet: sum });
    }
    return Array.from(map.values());
  };

  // Palet/Sandık için çocuk (kutu/poşet) listesi; state + hint + hareket defterinden toparla
  const getParentChildren = (no: string): string[] => {
    const s = new Set<string>();
    const fromState = paletMap.get(no)?.children || [];
    for (const c of fromState) s.add(c);
    const fromHints = childrenHints[no] || [];
    for (const c of fromHints) s.add(c);
    const log = moveLog[no];
    if (log) {
      for (const arr of Object.values(log)) {
        for (const { child } of arr) s.add(child);
      }
    }
    return Array.from(s);
  };

  // Find current parent (Palet/Sandık) of a child capsule (kutu/poşet); returns container no or undefined
  const getChildParent = (childNo: string): string | undefined => {
    // from explicit state
    for (const p of paletler) {
      if (p.tip === 'Palet' || p.tip === 'Sandık') {
        const kids = new Set([...(p.children || []), ...((childrenHints[p.no] || []))]);
        if (kids.has(childNo)) return p.no;
      }
    }
    // from move logs
    for (const [parent, moves] of Object.entries(moveLog)) {
      const any = Object.values(moves).some(arr => arr.some(e => e.child === childNo));
      if (any) return parent;
    }
    return undefined;
  };

  const getContainerPrintData = (containerNo: string) => {
    const container = paletMap.get(containerNo);
    const items = getContainerLines(containerNo);
    const children = getParentChildren(containerNo);
    const log = moveLog[containerNo] || {};
    const childDetails = children.map((childNo) => {
      const details: { kod: string; ad: string; adet: number }[] = [];
      for (const [urunKod, entries] of Object.entries(log)) {
        const total = entries
          .filter((entry) => entry.child === childNo)
          .reduce((sum, entry) => sum + entry.qty, 0);
        if (total > 0) {
          const product = urunMap.get(urunKod);
          details.push({ kod: urunKod, ad: product?.ad || "-", adet: total });
        }
      }
      let toplam = details.reduce((s, d) => s + d.adet, 0);
      if (toplam === 0) {
        const fallback = capsuleArchive[childNo] || 0;
        if (fallback > 0) {
          details.push({ kod: "-", ad: "Toplam", adet: fallback });
          toplam = fallback;
        }
      }
      const { prefix } = parseStationAndType(childNo);
      const istasyon = prefix ? PREFIX_TO_ISTASYON[prefix] || prefix : undefined;
      return {
        no: childNo,
        istasyon,
        toplam,
        items: details,
      };
    });

    const istasyonSorumlulari = Array.from(
      new Map(
        childDetails
          .filter((c) => c.istasyon)
          .map((c) => {
            const sorumlu = c.istasyon ? ISTASYON_PAKETLEYEN[c.istasyon] || "-" : "-";
            return [c.istasyon, sorumlu] as const;
          })
      ).entries()
    ).map(([istasyon, sorumlu]) => ({ istasyon, sorumlu }));

    const toplamAdet = container?.adet ?? items.reduce((sum, row) => sum + row.adet, 0);
    const paketYapilari = (container?.paketYapilari && container.paketYapilari.length)
      ? container.paketYapilari
      : Array.from(new Set(items.map((it: any) => it.kutuTipi).filter(Boolean)));

    // Siparişe ait Palet/Sandık sayıları (özet)
    const related = paletler.filter(p => (p.tip === 'Palet' || p.tip === 'Sandık') && p.siparis === (container?.siparis || selectedSiparis?.no || siparisler[0].no));
    const countPalet = related.filter(p => p.tip === 'Palet').length;
    const countSandik = related.filter(p => p.tip === 'Sandık').length;

    return {
      no: containerNo,
      tip: container?.tip || "Palet",
      siparis: container?.siparis || selectedSiparis?.no || siparisler[0].no,
      musteri: selectedSiparis?.musteriAdi || siparisler[0].musteriAdi,
      aracTuru: container?.aracTuru,
      aracNo: container?.aracNo,
      soforAdi: container?.soforAdi,
      sevkiyatYetkilisi: container?.sevkiyatYetkilisi,
      istasyonlar: istasyonSorumlulari,
      toplamAdet,
      paketYapilari,
      children: childDetails,
      items,
      countPalet,
      countSandik,
      teslimAldi: container?.teslimAldi,
      teslimTarihi: container?.teslimTarihi,
      teslimYeri: container?.teslimYeri,
      teslimNotu: container?.teslimNotu,
      teslimOnay: container?.teslimOnay ?? false,
    };
  };

  const getStationPrintData = (productCode: string) => {
    const urun = urunler.find((u) => u.kod === productCode);
    if (!urun) return null;
    const assignments = urun.atananlar.map((a) => {
      const container = paletMap.get(a.no);
      return {
        paketNo: a.no,
        tip: container?.tip,
        adet: a.adet,
        paketleyen: a.paketleyen || (urun.istasyon ? ISTASYON_PAKETLEYEN[urun.istasyon] : undefined) || "-",
        kutuTipi: a.kutuTipi || "-",
      };
    });
    const toplamAtanan = assignments.reduce((sum, a) => sum + a.adet, 0);
    return {
      urun,
      assignments,
      kalan: urun.kalan,
      toplamAtanan,
      siparis: selectedSiparis?.no || siparisler[0].no,
      musteri: selectedSiparis?.musteriAdi || siparisler[0].musteriAdi,
    };
  };

  const getSmallCapsuleSummary = (childNo: string) => {
    const { prefix, tip } = parseStationAndType(childNo);
    const istasyon = prefix ? PREFIX_TO_ISTASYON[prefix] || prefix : undefined;
    let toplam = 0;
    for (const u of urunler) {
      for (const a of u.atananlar) {
        if (a.no === childNo) toplam += a.adet;
      }
    }
    if (toplam === 0) toplam = capsuleArchive[childNo] || 0;
    return {
      no: childNo,
      tip,
      istasyon,
      toplam,
    };
  };

  const getShipmentGroupPrintData = (groupKey: string) => {
    const group = sevkiyatGruplari.find((g) => g.key === groupKey);
    if (!group) return null;
    const assigned = Object.entries(group.assignedMap).map(([paletNo, cnt]) => {
      const container = paletMap.get(paletNo);
      let toplamAdet = container?.adet ?? 0;
      if (toplamAdet === 0) {
        for (const u of urunler) {
          for (const a of u.atananlar) {
            if (a.no === paletNo) toplamAdet += a.adet;
          }
        }
      }
      return {
        paletNo,
        tip: container?.tip || "Palet",
        sevkiyatYetkilisi: container?.sevkiyatYetkilisi || "-",
        kapsulSayisi: cnt,
        toplamAdet,
      };
    });
    const capsules = group.children.map(getSmallCapsuleSummary);
    const istasyonAdi = PREFIX_TO_ISTASYON[group.prefix] || group.prefix;
    return {
      key: group.key,
      tip: group.tip,
      paketNoOzet: istasyonAdi,
      istasyonAdi,
      children: capsules,
      assigned,
      siparis: selectedSiparis?.no || siparisler[0].no,
      musteri: selectedSiparis?.musteriAdi || siparisler[0].musteriAdi,
    };
  };

  // Adjust how many children from a Sevkiyat group should be under a specific parent container
  const handleGroupSetCount = (g: any, parentNo: string, newCount: number) => {
    const current = g.assignedMap[parentNo] || 0;
    const target = Math.max(0, Math.min(newCount, g.adet));
    if (target === current) return;

    if (target < current) {
      // remove (current - target) children from this parent
      let toRemove = current - target;
      while (toRemove > 0) {
        handleGroupUnassignOne(g, parentNo);
        toRemove -= 1;
      }
      return;
    }
    // need to add (target - current) children from the group's unassigned pool
    let need = target - current;
    const available = g.children.filter((ch: string) => !getChildParent(ch));
    const toAdd = available.slice(0, need);
    if (toAdd.length === 0) return; // nothing available

    // add these children under the parentNo and move product quantities accordingly
    setPaletler(prev => prev.map(p => p.no === parentNo ? { ...p, children: Array.from(new Set([...(p.children || []), ...toAdd])) } : p));
    setChildrenHints(prev => ({ ...prev, [parentNo]: Array.from(new Set([...(prev[parentNo] || []), ...toAdd])) }));

    const productChildMoves: Record<string, { child: string; qty: number }[]> = {};
    setUrunler(prev => {
      const yeni = prev.map(u => {
        let moved = 0;
        const rest: UrunAtama[] = [];
        for (const a of u.atananlar) {
          if (toAdd.includes(a.no)) {
            if (!productChildMoves[u.kod]) productChildMoves[u.kod] = [];
            productChildMoves[u.kod].push({ child: a.no, qty: a.adet });
            moved += a.adet;
          } else {
            rest.push(a);
          }
        }
        if (moved > 0) {
          const idx = rest.findIndex(a => a.no === parentNo);
          if (idx === -1) rest.push({ no: parentNo, adet: moved });
          else rest[idx] = { ...rest[idx], adet: rest[idx].adet + moved };
        }
        const yeniKalan = u.adet - rest.reduce((s, a) => s + a.adet, 0);
        return { ...u, atananlar: rest, kalan: yeniKalan };
      });
      recomputeContainersFromUrunler(yeni);
      return yeni;
    });

    setMoveLog(prev => ({
      ...prev,
      [parentNo]: {
        ...(prev[parentNo] || {}),
        ...Object.fromEntries(Object.entries(productChildMoves).map(([k, v]) => [k, [ ...(prev[parentNo]?.[k] || []), ...v ]]))
      }
    }));
    recordCapsuleTotals(productChildMoves);
  };

  // Sipariş barkodunu (order-level) popover açıldığında üretir
  const ensureOrderQr = async (orderNo: string) => {
    const key = `order:${orderNo}`;
    if (qrMap[key]) return;
    const items = getOrderItemSummary(orderNo);
    const containers = getOrderContainers(orderNo).map((c) => ({ no: c.no, tip: c.tip }));
    const data = await QRCode.toDataURL(
      JSON.stringify({ type: "order", order: orderNo, items, containers })
    );
    setQrMap((prev) => ({ ...prev, [key]: data }));
  };

  // Sevkiyat satırı (ürün) için etiket QR üret
  const ensureSevkiyatRowQr = async (u: Urun) => {
    const key = `label:${u.kod}`;
    if (qrMap[key]) return;
    const qty = parseQtyText(u.adetText ?? u.adet ?? 0);
    const paketleyen = getLastPaketleyen(u);
    const parent = getLastParentContainer(u);
    const boxType = getLastBoxType(u);
    const payload = {
      type: "label",
      scope: "sevkiyat-item",
      productCode: u.stokKodu || u.kod,
      productName: u.ad,
      qty,
      unit: u.birim || "Adet",
      paketleyen,
      paketNo: parent?.no,
      paketTip: parent?.tip,
      kutuTipi: boxType,
      order: selectedSiparis?.no || siparisler[0].no,
      musteri: selectedSiparis?.musteriAdi || siparisler[0].musteriAdi,
    };
    const data = await QRCode.toDataURL(JSON.stringify(payload));
    setQrMap(prev => ({ ...prev, [key]: data }));
  };

  const recomputeContainersFromUrunler = (urunlerYeni: Urun[]) => {
    // Ürün atamalarından konteyner özetini türet (sıfır adet olanlar gösterilmez)
    const agg = new Map<string, { adet: number; set: Set<string>; kutuSet: Set<string> }>();
    for (const u of urunlerYeni) {
      for (const a of u.atananlar) {
        if (!agg.has(a.no)) agg.set(a.no, { adet: 0, set: new Set<string>(), kutuSet: new Set<string>() });
        const cur = agg.get(a.no)!;
        cur.adet += a.adet;
        cur.set.add(u.kod);
        if (a.kutuTipi) cur.kutuSet.add(a.kutuTipi);
      }
    }

    const out: Konteyner[] = [];
    // Build from agg (nonzero adet)
    for (const [no, val] of agg.entries()) {
      if (val.adet <= 0) continue; // sıfır adet olanları listeleme
      const prev = paletMap.get(no);
      const inferTip = (() => {
        const prevTip = prev?.tip;
        if (prevTip) return prevTip;
        // İstasyonlu format: XXX-<L><NNN>
        const dash = no.indexOf('-');
        if (dash > 0) {
          const seg = no.slice(dash + 1); // e.g. P001, K002
          if (seg.startsWith('K')) return 'Kutu';
          if (seg.startsWith('P')) return 'Poşet';
        }
        // Sevkiyat formatı: P001/S002
        if (no.startsWith('S')) return 'Sandık';
        if (no.startsWith('P')) return 'Palet';
        if (no.startsWith('K')) return 'Kutu';
        return 'Palet';
      })();
      // paket yapıları birleşimi
      const prevPy = new Set([...(prev?.paketYapilari || [])]);
      for (const t of val.kutuSet) prevPy.add(t);
      out.push({
        no,
        tip: inferTip,
        siparis: selectedSiparis?.no || siparisler[0].no,
        urunKodlari: Array.from(val.set),
        adet: val.adet,
        durum: prev?.durum || "Hazırlanıyor",
        sevkiyatYetkilisi: prev?.sevkiyatYetkilisi,
        children: (childrenHints[no] && childrenHints[no].length ? childrenHints[no] : prev?.children),
        paketYapilari: Array.from(prevPy),
      });
    }
    // Append existing containers with 0 adet if not already included
    const aggNos = new Set(Array.from(agg.keys()));
    for (const prev of paletler) {
      if (!aggNos.has(prev.no)) {
        out.push({
          ...prev,
          adet: 0,
        });
      }
    }
    setPaletler(out);
  };

  const kaydetAtama = () => {
    if (!selectedUrun) return;
    const kalan = selectedUrun.kalan;
    const tipLabel: "Palet" | "Sandık" | "Kutu" | "Poşet" | "" =
      paketTipi === "palet" ? "Palet" :
      paketTipi === "sandik" ? "Sandık" :
      paketTipi === "kutu" ? "Kutu" :
      paketTipi === "poset" ? "Poşet" : "";

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
    const paketleyenName = aktifAsama === 'sevkiyat'
      ? (seciliSevkiyatYetkilisi || '')
      : (selectedUrun?.istasyon ? (ISTASYON_PAKETLEYEN[selectedUrun.istasyon] || '') : '');
    if (aktifAsama !== 'sevkiyat' && !paketleyenName) {
      setHata("Paketleyen bilgisi bulunamadı.");
      return;
    }
    if (aktifAsama === "sevkiyat" && !seciliSevkiyatYetkilisi) {
      setHata("Sevkiyat yetkilisi seçilmelidir.");
      return;
    }
    if (aktifAsama === "sevkiyat") {
      const prodQty = parseQtyText(selectedUrun.adetText ?? selectedUrun.adet);
      const sevkQty = parseQtyText((selectedUrun.sevkiyatText ?? selectedUrun.sevkiyatQty) ?? 0);
      if (sevkQty < prodQty) {
        setHata(`Sevk Depo Miktarı (${selectedUrun.sevkiyatText ?? selectedUrun.sevkiyatQty ?? 0}) Miktardan (${selectedUrun.adetText ?? selectedUrun.adet}) az; paketleme yapılamaz.`);
        return;
      }
      if (adet > sevkQty) {
        setHata(`Paketlenecek adet (${adet}) sevk depo miktarını (${sevkQty}) aşamaz.`);
        return;
      }
    }

    let hedefNo = seciliKonteyner;
    if (seciliKonteyner === "yeni") {
      if (!tipLabel) {
        setHata("Yeni oluşturmak için paket tipi seçin.");
        return;
      }
      // İstasyon adımı kaldırıldığı için doğrudan genel kod üretimi kullanılır
      hedefNo = nextCode(tipLabel);
      // Sevkiyat aşamasında yeni konteyner açılıyorsa, sevkiyat yetkilisini atayalım
      if (aktifAsama === "sevkiyat") {
        setPaletler(prev => ([
          ...prev,
          {
            no: hedefNo,
            tip: tipLabel,
            siparis: selectedSiparis?.no || siparisler[0].no,
            urunKodlari: [],
            adet: 0,
            durum: "Hazırlanıyor",
            sevkiyatYetkilisi: seciliSevkiyatYetkilisi || undefined,
            paketYapilari: paketYapisi ? [paketYapisi] : [],
          },
        ]));
      }
    }
    // İstasyon adımı olmadığı için istasyon-özel kısıtlar uygulanmaz
    // If assigning to existing container in sevkiyat and it has no supervisor yet, set it
    if (aktifAsama === "sevkiyat" && seciliKonteyner !== "yeni") {
      setPaletler(prev => prev.map(p => {
        if (p.no !== hedefNo) return p;
        const py = new Set([...(p.paketYapilari || [])]);
        if (paketYapisi) py.add(paketYapisi);
        return {
          ...p,
          sevkiyatYetkilisi: p.sevkiyatYetkilisi || seciliSevkiyatYetkilisi || undefined,
          paketYapilari: Array.from(py),
        };
      }));
    }

    // Ürün güncelle
    const urunlerYeni = urunler.map((u) => {
      if (u.kod !== selectedUrun.kod) return u;
      const yeniKalan = (u.kalan || 0) - adet;
      const idx = u.atananlar.findIndex((a) => a.no === hedefNo);
      const yeniAtananlar = [...u.atananlar];
      if (idx === -1) yeniAtananlar.push({ no: hedefNo, adet, paketleyen: paketleyenName || undefined, kutuTipi: paketYapisi || undefined });
      else yeniAtananlar[idx] = {
        ...yeniAtananlar[idx],
        adet: yeniAtananlar[idx].adet + adet,
        paketleyen: paketleyenName || yeniAtananlar[idx].paketleyen,
        kutuTipi: paketYapisi || yeniAtananlar[idx].kutuTipi,
      };
      // Sevk depo miktarını düş
      const currentSevk = parseQtyText(u.sevkiyatText ?? u.sevkiyatQty ?? 0);
      const nextSevk = Math.max(0, currentSevk - adet);
      // SevkHazir'ı otomatik ata: Sevkiyat Depo miktarı sıfıra düştüyse true yap
      const sevkHazirFlag = nextSevk === 0 ? true : (u.sevkHazir ?? false);
      return {
        ...u,
        kalan: yeniKalan,
        atananlar: yeniAtananlar,
        sevkiyatQty: nextSevk,
        sevkiyatText: String(nextSevk),
        sevkHazir: sevkHazirFlag,
      };
    });

    setUrunler(urunlerYeni);
    recomputeContainersFromUrunler(urunlerYeni);
    setShowModal(false);
    // inline paketleme kaldırıldı
    setPaketYapisi("");
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
  // Bir palet/sandık altından tek bir kutu/poşeti çıkart (hareketleri iade eder)
  const unassignOneChild = (parentNo: string, childNo: string) => {
    // 1) Ürün hareketlerini geri al
    const log = moveLog[parentNo];
    setUrunler(prev => {
      const yeni = prev.map(u => {
        let parentQty = 0;
        let childReturn = 0;

        // parent'taki toplam qty (bu ürün için)
        const parentIdx = u.atananlar.findIndex(a => a.no === parentNo);
        if (parentIdx !== -1) parentQty = u.atananlar[parentIdx].adet;

        const rest = u.atananlar.filter((_, i) => i !== parentIdx);

        // log varsa: sadece bu çocuğa taşınmış miktarı iade et
        const entries = log?.[u.kod]?.filter(e => e.child === childNo) || [];
        const movedBack = entries.reduce((s, e) => s + e.qty, 0);
        if (movedBack > 0) {
          childReturn = movedBack;
        } else {
          // log yoksa fallback: parent’taki kadarını iade et (tek çocuk varsayımı)
          childReturn = parentQty;
        }

        if (parentQty > 0) {
          const newParentQty = Math.max(0, parentQty - childReturn);
          if (newParentQty > 0) rest.push({ no: parentNo, adet: newParentQty });
        }

        if (childReturn > 0) {
          const cIdx = rest.findIndex(a => a.no === childNo);
          if (cIdx === -1) rest.push({ no: childNo, adet: childReturn });
          else rest[cIdx] = { ...rest[cIdx], adet: rest[cIdx].adet + childReturn };
        }

        const yeniKalan = u.adet - rest.reduce((s, a) => s + a.adet, 0);
        return { ...u, atananlar: rest, kalan: yeniKalan };
      });
      recomputeContainersFromUrunler(yeni);
      return yeni;
    });

    // 2) Parent’ın çocuk listesinden çıkar ve log/hints’i temizle
    setPaletler(prev => prev.map(p => {
      if (p.no !== parentNo) return p;
      const kids = new Set(p.children || []);
      kids.delete(childNo);
      return { ...p, children: Array.from(kids) };
    }));
    setChildrenHints(prev => {
      const cp = { ...prev };
      if (cp[parentNo]) cp[parentNo] = cp[parentNo].filter(c => c !== childNo);
      return cp;
    });
    setMoveLog(prev => {
      const lp = { ...prev };
      if (lp[parentNo]) {
        const m = { ...lp[parentNo] };
        Object.keys(m).forEach(k => (m[k] = (m[k] || []).filter(e => e.child !== childNo)));
        lp[parentNo] = m;
      }
      return lp;
    });
  };

  // Atanan paket(ler) rozetinden 1 kapsül çıkar
  const handleGroupUnassignOne = (g: any, parentNo: string) => {
    // bu gruptaki çocuklardan, parent altında bulunan ilkini bul
    const parentKids = new Set(getParentChildren(parentNo));
    const targetChild = g.children.find((ch: string) => parentKids.has(ch));
    if (!targetChild) return;
    unassignOneChild(parentNo, targetChild);
  };
  // -------- Cancel Container (Sevkiyat) ---------
  const cancelContainer = (containerNo: string) => {
    const log = moveLog[containerNo];

    setUrunler(prev => {
      const yeni = prev.map(u => {
        const idx = u.atananlar.findIndex(a => a.no === containerNo);
        if (idx === -1) return u;

        const removedQty = u.atananlar[idx].adet;
        const rest = u.atananlar.filter((_, i) => i !== idx);

        if (log && log[u.kod] && log[u.kod].length > 0) {
          // Loglu: aynı çocuklara, aynı miktarlarla iade et
          for (const entry of log[u.kod]) {
            const cIdx = rest.findIndex(a => a.no === entry.child);
            if (cIdx === -1) rest.push({ no: entry.child, adet: entry.qty });
            else rest[cIdx] = { ...rest[cIdx], adet: rest[cIdx].adet + entry.qty };
          }
        } else {
          // Logsuz: eşit dağıtım yap ya da kalan'a iade et
          const children = paletMap.get(containerNo)?.children || [];
          if (children.length > 0) {
            const base = Math.floor(removedQty / children.length);
            let rem = removedQty % children.length;
            for (const ch of children) {
              const add = base + (rem > 0 ? 1 : 0);
              if (rem > 0) rem -= 1;
              if (add <= 0) continue;
              const cIdx = rest.findIndex(a => a.no === ch);
              if (cIdx === -1) rest.push({ no: ch, adet: add });
              else rest[cIdx] = { ...rest[cIdx], adet: rest[cIdx].adet + add };
            }
          } else {
            const yeniKalan = u.kalan + removedQty;
            return { ...u, atananlar: rest, kalan: yeniKalan };
          }
        }

        const yeniKalan = u.adet - rest.reduce((s, a) => s + a.adet, 0);
        return { ...u, atananlar: rest, kalan: yeniKalan };
      });
      recomputeContainersFromUrunler(yeni);
      return yeni;
    });

    // Konteyneri listeden düş ve logu temizle
    setPaletler(prev => prev.filter(p => p.no !== containerNo));
    setMoveLog(prev => {
      const cp = { ...prev };
      delete cp[containerNo];
      return cp;
    });
  };
  // -------- Container Status (Kapat -> Tamamlandı) ---------
  const sealContainer = (no: string) => {
    // Sipariş Detayı tamamlanmadan kapatma engellenir (ekstra güvenlik)
    if (!tumUrunlerTamamlandi) return;
    setPaletler((prev) => prev.map((p) => (p.no === no ? { ...p, durum: "Tamamlandı" } : p)));
  };

  const markLoaded = (no: string) => {
    setPaletler((prev) => prev.map((p) => (p.no === no ? { ...p, durum: "Kamyona Yüklendi" } : p)));
  };

  // Sipariş Detayı tamamlanma durumu bozulursa tüm konteynerleri "Hazırlanıyor" yap
  useEffect(() => {
    if (!tumUrunlerTamamlandi) {
      setPaletler(prev => prev.map(p => p.durum === "Tamamlandı" ? { ...p, durum: "Hazırlanıyor" } : p));
    }
  }, [tumUrunlerTamamlandi]);

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
        const data = getContainerPrintData(no);
        const payload = {
          type: "container",
          no,
          order: data.siparis,
          tip: data.tip,
          items: data.items,
          sevkiyatYetkilisi: data.sevkiyatYetkilisi,
          istasyonlar: data.istasyonlar,
          teslimAldi: data.teslimAldi,
          teslimTarihi: data.teslimTarihi,
          teslimYeri: data.teslimYeri,
          teslimNotu: data.teslimNotu,
          teslimOnay: data.teslimOnay,
          children: data.children.map((child) => ({
            no: child.no,
            istasyon: child.istasyon,
            toplam: child.toplam,
            items: child.items,
          })),
        };
        newMap[no] = await QRCode.toDataURL(JSON.stringify(payload));
      } else if (printTarget.type === "station") {
        const data = getStationPrintData(printTarget.product);
        if (data) {
          const payload = {
            type: "station",
            product: data.urun.kod,
            name: data.urun.ad,
            istasyon: data.urun.istasyon,
            siparis: data.siparis,
            musteri: data.musteri,
            assignments: data.assignments,
            kalan: data.kalan,
          };
          newMap[`station:${data.urun.kod}`] = await QRCode.toDataURL(JSON.stringify(payload));
        }
      } else if (printTarget.type === "shipmentGroup") {
        const data = getShipmentGroupPrintData(printTarget.groupKey);
        if (data) {
          const payload = {
            type: "shipmentGroup",
            key: data.key,
            tip: data.tip,
            paketNoOzet: data.paketNoOzet,
            siparis: data.siparis,
            musteri: data.musteri,
            assigned: data.assigned,
            children: data.children,
          };
          newMap[`shipment:${data.key}`] = await QRCode.toDataURL(JSON.stringify(payload));
        }
      } else if (printTarget.type === "label") {
        const u = urunler.find(x => x.kod === printTarget.product);
        if (u) {
          const qty = parseQtyText(u.adetText ?? u.adet ?? 0);
      const paketleyen = getLastPaketleyen(u);
          const payload = {
            type: "label",
            scope: "sevkiyat-item",
            productCode: u.stokKodu || u.kod,
            productName: u.ad,
            qty,
            unit: u.birim || "Adet",
            paketleyen,
            order: selectedSiparis?.no || siparisler[0].no,
            musteri: selectedSiparis?.musteriAdi || siparisler[0].musteriAdi,
          };
          newMap[`label:${u.kod}`] = await QRCode.toDataURL(JSON.stringify(payload));
        }
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
    const k = nextCode("Kutu");
    console.assert(/^K\d{3}$/.test(k), `nextCode Kutu format hatası: ${k}`);
    const b = nextCode("Poşet");
    console.assert(/^P\d{3}$/.test(b), `nextCode Poşet format hatası: ${b}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- render -----
  return (
    <div className="p-6 space-y-6">
      <style jsx global>{`
        @media print {
          @page { size: A4 portrait; margin: 5mm; }
          html, body { width: 100%; height: auto; -webkit-print-color-adjust: exact; print-color-adjust: exact; margin: 0; }
          .no-print { display: none !important; }
          .print-container { width: 100%; max-width: none !important; padding: 0 !important; border: none !important; }
          /* A4: 210mm - 2*5mm margin = 200mm efektif içerik */
          .packing-page {
            width: 200mm !important;
            max-width: 200mm !important;
            margin: 0 auto !important;
            padding: 12mm 10mm 8mm 10mm !important;
            background: white !important;
          }
        }
        /* Ekran önizleme genişliği */
        @media screen {
          .packing-page { width: 100%; max-width: 1180px; margin: 0 auto; padding: 24px 24px 32px; }
        }
        /* Packing List stilleri */
        .pl-box {
          border: 1px solid #d1d5db;
          border-radius: 10px;
        }
        .pl-head {
          background: #4b4b4b;
          color: white;
          letter-spacing: 0.5px;
        }
        .pl-table th {
          background: #4e4e4e;
          color: white;
          font-weight: 700;
          font-size: 12.5px;
        }
        .pl-table th,
        .pl-table td {
          border: 1px solid #7c7c7c;
        }
        .pl-table td {
          font-size: 13px;
        }
        .pl-total-row td {
          background: #f3f3f3;
        }
        .pl-origin {
          background: #4b4b4b;
          color: white;
          letter-spacing: 0.8px;
        }
        .pl-footer-label {
          font-weight: 700;
          letter-spacing: 0.4px;
        }
      `}</style>
      <h1 className="text-2xl font-bold">Paketleme Takip Paneli</h1>
      <div className="flex gap-2 mb-2">
        <Button variant={aktifAsama === "panel" ? "default" : "outline"} onClick={() => handleStageNavClick("panel")}>
          1) Paketleme Takip Paneli
        </Button>
        <Button
          variant={aktifAsama === "sevkiyat" ? "default" : "outline"}
          onClick={() => handleStageNavClick("sevkiyat")}
        >
          2) Sevkiyat Paketleme
        </Button>
        <Button
          variant={aktifAsama === "yukleme" ? "default" : "outline"}
          onClick={() => handleStageNavClick("yukleme")}
        >
          3) Yükleme Alanı
        </Button>
        <Button
          variant={aktifAsama === "saha" ? "default" : "outline"}
          onClick={() => handleStageNavClick("saha")}
        >
          4) Saha Montaj / Depo
        </Button>
      </div>
      <Card className="p-4 border-dashed border-2 border-border bg-muted/30 no-print">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-base font-semibold">Paketleme Takip Paneli · Packing List</div>
            <div className="text-sm text-muted-foreground">
              Ekli şablon, paylaştığın görsele uygun A4 baskı için hazırlandı. Önizleyip yazdırabilirsin.
            </div>
          </div>
          <Button size="sm" onClick={() => setPackingListOpen(true)}>Önizleme / Yazdır</Button>
        </div>
      </Card>
      {/* Saha Montaj / Depo */}
      {aktifAsama === "saha" && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Saha Montaj / Depo</h2>
            <div className="flex items-center gap-4">
              <label className="text-sm flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={montajGorselleriYuklendi}
                  onChange={(e) => setMontajGorselleriYuklendi(e.target.checked)}
                />
                Montaj Görselleri Yüklendi
              </label>
              <div className="text-sm text-muted-foreground">Palet/Sandık teslim kayıtları</div>
            </div>
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>No</TableHead>
                <TableHead>Tip</TableHead>
                <TableHead>Toplam Adet</TableHead>
                <TableHead>Teslim Alan</TableHead>
                <TableHead>Tarih</TableHead>
                <TableHead>Yer</TableHead>
                <TableHead>Not</TableHead>
                <TableHead>Durum</TableHead>
                <TableHead>PDF</TableHead>
                <TableHead>Kaydet + Kabul Et</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paletSandiklar.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} className="text-xs text-muted-foreground">Kayıtlı palet/sandık bulunmuyor.</TableCell>
                </TableRow>
              ) : (
                paletSandiklar.map((p) => {
                  const f = getSahaField(p.no, p.tip);
                  return (
                    <TableRow key={p.no}>
                      <TableCell>{p.no}</TableCell>
                      <TableCell>{p.tip}</TableCell>
                      <TableCell>{p.adet}</TableCell>
                      <TableCell>
                        <Input
                          placeholder="Ad Soyad"
                          value={f.teslimAldi}
                          className={!f.teslimAldi ? "border-red-300" : undefined}
                          onChange={(e) => setSahaEdits((prev) => ({ ...prev, [p.no]: { ...prev[p.no], teslimAldi: e.target.value } }))}
                          disabled={!canSahaActions}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="date"
                          value={f.teslimTarihi}
                          className={!f.teslimTarihi ? "border-red-300" : undefined}
                          onChange={(e) => setSahaEdits((prev) => ({ ...prev, [p.no]: { ...prev[p.no], teslimTarihi: e.target.value } }))}
                          disabled={!canSahaActions}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          placeholder="Depo/Saha"
                          value={f.teslimYeri}
                          onChange={(e) => setSahaEdits((prev) => ({ ...prev, [p.no]: { ...prev[p.no], teslimYeri: e.target.value } }))}
                          disabled={!canSahaActions}
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          placeholder="Not"
                          value={f.teslimNotu}
                          onChange={(e) => setSahaEdits((prev) => ({ ...prev, [p.no]: { ...prev[p.no], teslimNotu: e.target.value } }))}
                          disabled={!canSahaActions}
                        />
                      </TableCell>
                      <TableCell>
                        {p.teslimOnay ? (
                          <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 border border-green-300 text-green-800">Kabul Edildi</span>
                        ) : (
                          <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 border border-gray-300 text-gray-700">Beklemede</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" title="PDF Kaydet/Yazdır" onClick={() => openContainerPrint(p.no)} disabled={!canSahaActions}>PDF</Button>
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          disabled={!canSahaActions || !isSahaValid(p.no, p.tip)}
                          onClick={() => {
                            const data = getSahaField(p.no, p.tip);
                            if (!isSahaValid(p.no, p.tip)) return;
                            updateContainerExact(p.no, p.tip, {
                              teslimAldi: data.teslimAldi,
                              teslimTarihi: data.teslimTarihi,
                              teslimYeri: data.teslimYeri,
                              teslimNotu: data.teslimNotu,
                              teslimOnay: true,
                              durum: "Teslim Edildi",
                            });
                            setAlertMsg("Teslim kaydı alındı.");
                            setAlertOpen(true);
                          }}
                        >
                          Kaydet + Kabul Et
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Sipariş arama / liste */}
      {aktifAsama === "panel" && (
      <Card className="p-4">
        <div className="grid grid-cols-5 gap-2 mb-4">
          <Input placeholder="Sipariş No" />
          <Input placeholder="Proje Adı" />
          <Input placeholder="Başlangıç Tarihi" type="date" />
          <Input placeholder="Bitiş Tarihi" type="date" />
          <Button>Listele</Button>
        </div>

        <div className="flex items-center justify-between mb-4">
          <div className="text-sm text-muted-foreground">
            {selectedSiparis ? `Seçili sipariş: ${selectedSiparis.no}` : "Lütfen bir sipariş seçin."}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!selectedSiparis}
            onClick={handleGoToSevkiyat}
          >
            Sevkiyat Paketlemeye Geç
          </Button>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>No</TableHead>
              <TableHead>Sipariş Tarihi</TableHead>
              <TableHead>Teslim Tarihi</TableHead>
              <TableHead>Sipariş Adı</TableHead>
              <TableHead>Süreç</TableHead>
              {/* <TableHead>Aşama</TableHead> REMOVED */}
              <TableHead>Müşteri Adı</TableHead>
              <TableHead>Proje</TableHead>
              <TableHead>Print</TableHead>
              <TableHead>Barkod</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {siparisler.map((s, i) => (
              <TableRow
                key={i}
                onClick={() => setSelectedSiparis(s)}
                className={`cursor-pointer hover:bg-gray-100 ${selectedSiparis?.no === s.no ? "bg-muted" : ""}`}
              >
                <TableCell>{s.no}</TableCell>
                <TableCell>{s.tarih}</TableCell>
                <TableCell>{s.teslim}</TableCell>
                <TableCell>{s.adi}</TableCell>
                <TableCell>
                  {(() => {
                    const sr = getSurecLabel();
                    const toneCls =
                      sr.tone === 'green' ? 'bg-green-100 border-green-300 text-green-800' :
                      sr.tone === 'violet' ? 'bg-violet-100 border-violet-300 text-violet-800' :
                      sr.tone === 'amber' ? 'bg-amber-100 border-amber-300 text-amber-800' :
                      sr.tone === 'blue' ? 'bg-blue-100 border-blue-300 text-blue-800' :
                      'bg-gray-100 border-gray-300 text-gray-800';
                    return (
                      <span className={`px-2 py-1 text-xs rounded border ${toneCls}`}>
                        {sr.text}
                      </span>
                    );
                  })()}
                </TableCell>
                {/* <TableCell>
                  {(["Araca Yüklendi", "Saha Teslim Tamamlandı"].includes(siparisAsama)) ? (
                    <span className="px-2 py-1 text-xs rounded bg-green-100 border border-green-300 text-green-800">
                      {siparisAsama}
                    </span>
                  ) : (
                    siparisAsama
                  )}
                </TableCell> */}
                <TableCell>{s.musteriAdi}</TableCell>
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
                <TableCell>
                  {tumUrunlerTamamlandi ? (
                    <Popover onOpenChange={(open) => { if (open) ensureOrderQr(s.no); }}>
                      <PopoverTrigger asChild>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => e.stopPropagation()}
                          title="Barkod Önizleme"
                        >
                          <Barcode className="w-4 h-4" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-56">
                        <div className="flex items-center justify-between">
                          <div className="text-sm font-medium">Sipariş Barkodu</div>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={(e) => { e.stopPropagation(); openOrderPrint(s.no); }}
                          >
                            Yazdır
                          </Button>
                        </div>
                        <div className="mt-2 flex items-center justify-center">
                          {qrMap[`order:${s.no}`]
                            ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={qrMap[`order:${s.no}`]} alt="order-qr" className="w-32 h-32" />
                            ) : (
                              <span className="text-xs text-muted-foreground">Oluşturuluyor…</span>
                            )}
                        </div>
                      </PopoverContent>
                    </Popover>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled
                      title="Barkod için tüm ürünler tamamlanmalı"
                    >
                      <Barcode className="w-4 h-4" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      )}

      {/* İstasyon adımı kaldırıldı */}

      {/* Packing List Print Preview */}
      <Dialog open={packingListOpen} onOpenChange={setPackingListOpen}>
        <DialogContent className="w-[98vw] h-[95vh] max-w-[1250px] max-h-none overflow-auto print-container bg-gray-100 p-0">
          <DialogHeader className="no-print px-6 pt-6 sticky top-0 bg-white z-10">
            <DialogTitle>Paketleme Takip Paneli · Packing List</DialogTitle>
          </DialogHeader>
          <div className="p-4 md:p-6 packing-page bg-white text-black">
            <div className="text-center pt-2 pb-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={arnikonLogo.src} alt="Arnikon" className="h-12 mx-auto object-contain" />
            </div>

            <div className="pl-head text-center py-2.5 text-lg font-bold tracking-wider border-y-2 border-gray-700">PACKING LIST</div>

            <div className="grid grid-cols-2 gap-4 py-4 text-sm">
              <div className="border border-gray-400 rounded-md p-3">
                <div className="text-xs font-semibold text-gray-500">INVOICE NO :</div>
                <div className="text-base font-bold tracking-wide">{packingListData.invoiceNo}</div>
              </div>
              <div className="border border-gray-400 rounded-md p-3 text-right">
                <div className="text-xs font-semibold text-gray-500">DATE :</div>
                <div className="text-base font-bold tracking-wide">{packingListData.date}</div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 pb-4 text-xs leading-relaxed">
              <div className="border border-gray-400 rounded-md p-3 space-y-1.5">
                <div className="text-sm font-bold">SUPPLIER :</div>
                <div className="grid grid-cols-[max-content,1fr] gap-x-2">
                  <span className="text-gray-600">Company Name:</span><span className="font-semibold">{packingListData.supplier.companyName}</span>
                  <span className="text-gray-600">Address:</span><span className="font-semibold">{packingListData.supplier.address}</span>
                  <span className="text-gray-600">City, State:</span><span className="font-semibold">{packingListData.supplier.city}</span>
                  <span className="text-gray-600">Country:</span><span className="font-semibold">{packingListData.supplier.country}</span>
                  <span className="text-gray-600">Phone:</span><span className="font-semibold">{packingListData.supplier.phone}</span>
                  <span className="text-gray-600">Fax:</span><span className="font-semibold">{packingListData.supplier.fax}</span>
                  <span className="text-gray-600">Email:</span><span className="font-semibold">{packingListData.supplier.email}</span>
                </div>
              </div>
              <div className="border border-gray-400 rounded-md p-3 space-y-1.5">
                <div className="text-sm font-bold">CONSIGNEE :</div>
                <div className="grid grid-cols-[max-content,1fr] gap-x-2">
                  <span className="text-gray-600">Company Name:</span><span className="font-semibold">{packingListData.consignee.companyName}</span>
                  <span className="text-gray-600">Address:</span><span className="font-semibold">{packingListData.consignee.address}</span>
                  <span className="text-gray-600">City, State:</span><span className="font-semibold">{packingListData.consignee.city}</span>
                  <span className="text-gray-600">Country:</span><span className="font-semibold">{packingListData.consignee.country}</span>
                  <span className="text-gray-600">Phone/ Fax:</span><span className="font-semibold">{packingListData.consignee.phone}</span>
                  <span className="text-gray-600">Email:</span><span className="font-semibold">{packingListData.consignee.email}</span>
                  <span className="text-gray-600">V.D/No:</span><span className="font-semibold">-</span>
                </div>
              </div>
            </div>

            <div className="pb-4 overflow-x-auto">
              <table className="pl-table w-full border-collapse">
                <thead>
                  <tr>
                    <th className="px-2 py-2 text-center w-12">NO</th>
                    <th className="px-2 py-2 text-left min-w-[200px]">DESCRIPTION OF ITEMS</th>
                    <th className="px-2 py-2 text-center w-16">UNIT</th>
                    <th className="px-2 py-2 text-center w-20">QTY</th>
                    <th className="px-2 py-2 text-center w-32 leading-tight">DIMENSIONS<br />LxWxH (cm)</th>
                    <th className="px-2 py-2 text-center w-28">PACKING TYPE</th>
                    <th className="px-2 py-2 text-center w-32">UNIT WEIGHT (kg)</th>
                    <th className="px-2 py-2 text-center w-36">TOTAL WEIGHTS (kg)</th>
                  </tr>
                </thead>
                <tbody>
                  {packingListData.items.map((row) => (
                    <tr key={row.no}>
                      <td className="px-2 py-1.5 text-center font-semibold align-top">{row.no}</td>
                      <td className="px-2 py-1.5 align-top">{row.description}</td>
                      <td className="px-2 py-1.5 text-center align-top">{row.unit}</td>
                      <td className="px-2 py-1.5 text-center align-top">{formatQty(row.qty)}</td>
                      <td className="px-2 py-1.5 text-center align-top">{row.dimensions || ""}</td>
                      <td className="px-2 py-1.5 text-center align-top">{row.packingType}</td>
                      <td className="px-2 py-1.5 text-right align-top">{formatWeight(row.unitWeight)}</td>
                      <td className="px-2 py-1.5 text-right font-semibold align-top">{formatWeight(row.totalWeight)}</td>
                    </tr>
                  ))}
                  <tr className="pl-total-row">
                    <td className="px-4 py-3 text-left font-semibold" colSpan={6}>
                      {packingListData.totalText}
                    </td>
                    <td className="px-2 py-3 text-center font-semibold align-middle">TOTAL WEIGHTS (kg)</td>
                    <td className="px-2 py-3 text-right font-bold text-base">
                      {formatWeight(packingListTotalWeight)}
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="pl-origin mt-3 text-center text-xs font-semibold py-2 uppercase">
                THAT GOODS ARE TURKISH ORIGIN AND 2025 MODEL
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs pb-3">
              <div className="space-y-1">
                <div className="grid grid-cols-[100px,1fr]">
                  <span className="pl-footer-label">NET WEIGHT:</span>
                  <span className="font-semibold">{formatWeight(packingListData.netWeight)} kg</span>
                </div>
                <div className="grid grid-cols-[100px,1fr]">
                  <span className="pl-footer-label">GROSS WEIGHT:</span>
                  <span className="font-semibold">{formatWeight(packingListData.grossWeight)} kg</span>
                </div>
                <div className="grid grid-cols-[100px,1fr]">
                  <span className="pl-footer-label">ONLY 5 CAP</span>
                  <span className="font-semibold">-</span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="grid grid-cols-[140px,1fr]">
                  <span className="pl-footer-label">VESSEL &amp; VOYAGE NO:</span>
                  <span className="font-semibold">{packingListData.vessel}</span>
                </div>
                <div className="grid grid-cols-[140px,1fr]">
                  <span className="pl-footer-label">PORT OF LOADING:</span>
                  <span className="font-semibold">{packingListData.portLoading}</span>
                </div>
                <div className="grid grid-cols-[140px,1fr]">
                  <span className="pl-footer-label">PORT OF DISCHARGE:</span>
                  <span className="font-semibold">{packingListData.portDischarge}</span>
                </div>
              </div>
            </div>

            <div className="text-center text-[10px] text-gray-500 pt-4 border-t border-gray-300">
              İSTİKLAL OSB MAH. FATİH CAD. NO:9/1 CUMRA / KONYA / TÜRKİYE<br />
              www.arnikon.com / info@arnikon.com.tr
            </div>
          </div>
          <div className="no-print flex justify-end gap-2 px-6 pb-6">
            <Button variant="outline" onClick={() => setPackingListOpen(false)}>Kapat</Button>
            <Button onClick={() => window.print()}>Yazdır</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* PRINT / PDF DIALOG (explicit teslim alan bilgileri ile) */}
      <Dialog open={printOpen} onOpenChange={setPrintOpen}>
        <DialogContent className="max-w-5xl print-container">
          <DialogHeader>
            <DialogTitle>Yazdırma Önizleme</DialogTitle>
          </DialogHeader>

          {/* Order / Container / Station / Group durumlarına göre içerik */}
          {!printTarget ? (
            <div className="text-sm text-muted-foreground">Herhangi bir yazdırma hedefi seçilmedi.</div>
          ) : printTarget.type === "container" ? (
            (() => {
              const data = getContainerPrintData(printTarget.containerNo);
              const qr = qrMap[printTarget.containerNo];
              return (
                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-lg font-semibold">
                        {data.tip} #{data.no} — Sipariş: {data.siparis}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        Müşteri: {data.musteri} • Palet: {data.countPalet} • Sandık: {data.countSandik}
                      </div>
                    </div>
                    {qr ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={qr} alt="QR" className="w-28 h-28 border" />
                    ) : (
                      <div className="text-xs text-muted-foreground">QR hazırlanıyor…</div>
                    )}
                  </div>

                  {/* Teslim Bilgileri */}
                  <div className="grid grid-cols-4 gap-3 border rounded p-3">
                    <div>
                      <div className="text-xs text-muted-foreground">Teslim Alan</div>
                      <div className="font-medium">{data.teslimAldi || "-"}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Tarih</div>
                      <div className="font-medium">{data.teslimTarihi || "-"}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Yer</div>
                      <div className="font-medium">{data.teslimYeri || "-"}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">Not</div>
                      <div className="font-medium break-words">{data.teslimNotu || "-"}</div>
                    </div>
                    <div className="col-span-4">
                      <div className="inline-flex items-center px-2 py-1 text-xs rounded border">
                        {data.teslimOnay ? "KABUL EDİLDİ" : "ONAY BEKLENİYOR"}
                      </div>
                    </div>
                  </div>

                  {/* İstasyon Sorumluları */}
                  {data.istasyonlar?.length ? (
                    <div className="border rounded p-3">
                      <div className="text-sm font-medium mb-2">İstasyon Sorumluları</div>
                      <div className="grid grid-cols-3 gap-2 text-sm">
                        {data.istasyonlar.map((r, idx) => (
                          <div key={idx} className="flex items-center justify-between border rounded px-2 py-1">
                            <span>{r.istasyon}</span>
                            <span className="text-muted-foreground">{r.sorumlu}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* Konteyner İçerik Özeti */}
                  <div className="border rounded p-3">
                    <div className="text-sm font-medium mb-2">Konteyner İçeriği</div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Stok Kodu</TableHead>
                          <TableHead>Ad</TableHead>
                          <TableHead className="text-right">Adet</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.items.length ? data.items.map((row, i) => (
                          <TableRow key={i}>
                            <TableCell>{row.kod}</TableCell>
                            <TableCell>{row.ad}</TableCell>
                            <TableCell className="text-right">{row.adet}</TableCell>
                          </TableRow>
                        )) : (
                          <TableRow>
                            <TableCell colSpan={3} className="text-xs text-muted-foreground">Kayıtlı ürün yok.</TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Bağlı Kutu/Poşet Özeti */}
                  {!!data.children?.length && (
                    <div className="border rounded p-3">
                      <div className="text-sm font-medium mb-2">Bağlı Kutu/Poşetler</div>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>No</TableHead>
                            <TableHead>İstasyon</TableHead>
                            <TableHead className="text-right">Toplam</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data.children.map((c) => (
                            <TableRow key={c.no}>
                              <TableCell>{c.no}</TableCell>
                              <TableCell>{c.istasyon || "-"}</TableCell>
                              <TableCell className="text-right">{c.toplam}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}

                  <div className="no-print flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setPrintOpen(false)}>Kapat</Button>
                    <Button onClick={() => window.print()}>Yazdır</Button>
                  </div>
                </div>
              );
            })()
          ) : printTarget.type === "order" ? (
            (() => {
              const key = `order:${printTarget.orderNo}`;
              const qr = qrMap[key] || "";
              const containers = getOrderContainers(printTarget.orderNo);
              const items = getOrderItemSummary(printTarget.orderNo);
              return (
                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-lg font-semibold">Sipariş Özeti — {printTarget.orderNo}</div>
                      <div className="text-sm text-muted-foreground">Kapsamlı konteyner ve kalem listesi</div>
                    </div>
                    {qr ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={qr} alt="QR" className="w-28 h-28 border" />
                    ) : (
                      <div className="text-xs text-muted-foreground">QR hazırlanıyor…</div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="border rounded p-3">
                      <div className="text-sm font-medium mb-2">Konteynerler</div>
                      <ul className="list-disc pl-5 text-sm">
                        {containers.map((c) => (
                          <li key={c.no}>{c.tip} #{c.no}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="border rounded p-3">
                      <div className="text-sm font-medium mb-2">Kalem Özeti</div>
                      <ul className="list-disc pl-5 text-sm">
                        {items.map((it, i) => (
                          <li key={i}>{it.kod} — {it.ad} — {it.adet}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="no-print flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setPrintOpen(false)}>Kapat</Button>
                    <Button onClick={() => window.print()}>Yazdır</Button>
                  </div>
                </div>
              );
            })()
          ) : printTarget.type === "station" ? (
            (() => {
              const key = `station:${printTarget.product}`;
              const qr = qrMap[key] || "";
              const sData = getStationPrintData(printTarget.product);
              return sData ? (
                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-lg font-semibold">İstasyon Etiketi — {sData.urun.ad}</div>
                      <div className="text-sm text-muted-foreground">Kalan: {sData.kalan} • Toplam Atanan: {sData.toplamAtanan}</div>
                    </div>
                    {qr ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={qr} alt="QR" className="w-28 h-28 border" />
                    ) : (
                      <div className="text-xs text-muted-foreground">QR hazırlanıyor…</div>
                    )}
                  </div>

                  <div className="border rounded p-3">
                    <div className="text-sm font-medium mb-2">Atamalar</div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Paket No</TableHead>
                          <TableHead>Tip</TableHead>
                          <TableHead>Paketleyen</TableHead>
                          <TableHead>Kutu Tipi</TableHead>
                          <TableHead className="text-right">Adet</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {sData.assignments.map((a, i) => (
                          <TableRow key={i}>
                            <TableCell>{a.paketNo}</TableCell>
                            <TableCell>{a.tip}</TableCell>
                            <TableCell>{a.paketleyen}</TableCell>
                            <TableCell>{a.kutuTipi}</TableCell>
                            <TableCell className="text-right">{a.adet}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  <div className="no-print flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setPrintOpen(false)}>Kapat</Button>
                    <Button onClick={() => window.print()}>Yazdır</Button>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">İstasyon verisi bulunamadı.</div>
              );
            })()
          ) : (
            // shipmentGroup
            (() => {
              const key = `shipment:${(printTarget as any).groupKey}`;
              const qr = qrMap[key] || "";
              const gData = getShipmentGroupPrintData((printTarget as any).groupKey);
              return gData ? (
                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-lg font-semibold">Sevkiyat Grubu — {gData.istasyonAdi}</div>
                      <div className="text-sm text-muted-foreground">{gData.tip} grubu</div>
                    </div>
                    {qr ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={qr} alt="QR" className="w-28 h-28 border" />
                    ) : (
                      <div className="text-xs text-muted-foreground">QR hazırlanıyor…</div>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="border rounded p-3">
                      <div className="text-sm font-medium mb-2">Atanan Palet/Sandıklar</div>
                      <ul className="list-disc pl-5 text-sm">
                        {gData.assigned.map((a, i) => (
                          <li key={i}>{a.tip} #{a.paletNo} — {a.kapsulSayisi} kapsül — {a.toplamAdet} adet</li>
                        ))}
                      </ul>
                    </div>
                    <div className="border rounded p-3">
                      <div className="text-sm font-medium mb-2">Kapsüller</div>
                      <ul className="list-disc pl-5 text-sm">
                        {gData.children.map((c, i) => (
                          <li key={i}>{c.no} — {c.istasyon || "-"} — {c.toplam}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div className="no-print flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setPrintOpen(false)}>Kapat</Button>
                    <Button onClick={() => window.print()}>Yazdır</Button>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">Grup verisi bulunamadı.</div>
              );
            })()
          )}
        </DialogContent>
      </Dialog>

      {/* Palet / Sandık Yönetimi */}
      {aktifAsama === "sevkiyat" && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Palet / Sandık Yönetimi</h2>
            <div className="flex items-center gap-2">
              
              <Button
                size="sm"
                variant="outline"
                title="Yükleme alanına geç"
                onClick={() => {
                  setYuklemeBasladi(true);
                  setAktifAsama("yukleme");
                }}
              >
                Yüklemeye Geç
              </Button>
            </div>
          </div>


          {/* Sevkiyat: Ürün Listesi (Stok Kodu, Stok Adı, İstasyon, Miktar, Birim, Sevk Depo Miktarı, İşlem) */}
          <div className="mb-6 border rounded p-3 bg-muted/10">
            <div className="text-sm font-medium mb-2">Sevkiyat Ürün Listesi</div>
            {hata && <div className="text-red-600 text-xs mb-2">{hata}</div>}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stok Kodu</TableHead>
                  <TableHead>Stok Adı</TableHead>
                  <TableHead>İstasyon</TableHead>
                  <TableHead>Üretim Depo</TableHead>
                  <TableHead>Birim</TableHead>
                  <TableHead>Sevk Depo</TableHead>
                  <TableHead>Paket No</TableHead>
                  <TableHead>Durum</TableHead>
                  <TableHead>Yazdır</TableHead>
                  <TableHead>İşlem</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Sevkiyat Ürün Listesi: yalnızca iki satır gösterilir */}
                {sevkiyatUrunRows.slice(0, 2).map((r, i) => (
                  <TableRow key={`${r.stokKodu}-${i}`}>
                    <TableCell>{r.stokKodu}</TableCell>
                    <TableCell>{r.ad}</TableCell>
                    <TableCell>{r.istasyon}</TableCell>
                    <TableCell>{r.miktar}</TableCell>
                    <TableCell>{r.birim}</TableCell>
                    <TableCell>{r.sevk}</TableCell>
                    <TableCell>{r.paketNo}</TableCell>
                    <TableCell>
                      {r.done ? (
                        <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 border border-green-300">Tamamlandı</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">Hazırlanıyor</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="outline" title="Etiket Yazdır" onClick={() => { ensureSevkiyatRowQr(r.ref); setPrintTarget({ type: 'label', product: r.ref.kod }); setPrintOpen(true); }}>
                        🖨️ Yazdır
                      </Button>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!r.canTransfer}
                          title={(() => {
                            const prod = parseQtyText(r.miktar);
                            const sevk = parseQtyText(r.sevk);
                            if (sevk < prod) return 'Sevk < Üretim: Onay pasif';
                            if (r.canTransfer) return 'Üretimden sevke transferi onayla';
                            return 'Zaten onaylı';
                          })()}
                          onClick={() => {
                            setUrunler(prev => prev.map(u => u.kod === r.key ? ({
                              ...u,
                              sevkHazir: true,
                            }) : u));
                          }}
                        >
                          Transferi Onayla
                        </Button>
                        <Button
                          size="sm"
                          disabled={!r.ready}
                          title={(() => { const prod = parseQtyText(r.miktar); const sevk = parseQtyText(r.sevk); if (!r.ready) return 'Transfer onayı gerekli'; if (sevk < prod) return `Sevk Depo Miktarı (${r.sevk}) Miktardan (${r.miktar}) az`; return 'Paketlemeye başla'; })()}
                          onClick={() => {
                            const prod = parseQtyText(r.miktar);
                            const sevk = parseQtyText(r.sevk);
                            if (!r.ready) { openAlert('Transfer onayı yapılmadan paketleme yapılamaz.'); return; }
                            if (sevk < prod) { openAlert(`Sevk Depo Miktarı (${r.sevk}) Miktardan (${r.miktar}) az; paketleme yapılamaz.`); return; }
                            setSelectedUrun(r.ref);
                            setPaketTipi('palet');
                            setSeciliKonteyner('yeni');
                            setAdet(Math.max(1, parseQtyText(r.sevk)));
                            setSeciliSevkiyatYetkilisi(DEFAULT_SEVKIYAT_YETKILISI);
                            setPaketYapisi('');
                            setHata('');
                            setShowModal(true);
                          }}
                        >
                          Paketle
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {sevkiyatUrunRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-xs text-muted-foreground">Gösterilecek ürün bulunamadı.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {/* İstasyondan gelen gruplanmış görünüm kaldırıldı */}
          <div className="mt-4 text-right text-sm font-semibold text-red-600">
            Toplam: Palet ({paletTipSayilari.Palet || 0}) / Sandık ({paletTipSayilari["Sandık"] || 0})
          </div>

      <Dialog open={sevkiyatModalOpen} onOpenChange={(open)=>{ setSevkiyatModalOpen(open); if(!open){ setSevkiyatGroup(null); setSevkiyatQty(1);} }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ürün Paketleme Ataması</DialogTitle>
          </DialogHeader>
          {(sevkiyatGroup || seciliKucukNo) && (
            <div className="space-y-3">
              {sevkiyatGroup ? (
                <>
                  <p><b>Paket:</b> ({sevkiyatGroup.children.join(', ')})</p>
                  <p><b>Kalan Adet:</b> {sevkiyatGroup.kalan}</p>
                  <p><b>Paketleyen:</b> {seciliSevkiyatYetkilisi || '-'}</p>
                </>
              ) : (
                <>
                  <p><b>Kutu/Poşet:</b> {seciliKucukNo}</p>
                  <p><b>Kalan Adet:</b> 1</p>
                  <p><b>Paketleyen:</b> {seciliSevkiyatYetkilisi || '-'}</p>
                </>
              )}

              <Select value={sevkiyatTargetTip} onValueChange={(v: any) => setSevkiyatTargetTip(v)}>
                <SelectTrigger><SelectValue placeholder="Paket Tipi Seç (Palet / Sandık)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Palet">Palet</SelectItem>
                  <SelectItem value="Sandık">Sandık</SelectItem>
                </SelectContent>
              </Select>

              <Select disabled={!sevkiyatTargetTip} onValueChange={(v: any) => setSevkiyatTargetNo(v)}>
                <SelectTrigger>
                  <SelectValue placeholder={sevkiyatTargetTip ? "Mevcut seç veya Yeni Oluştur" : "Önce paket tipini seçin"} />
                </SelectTrigger>
                <SelectContent>
                  {paletlerFlat.filter(p => p.tip === sevkiyatTargetTip).map((p, i) => (
                    <SelectItem key={i} value={p.no}>{p.no} - {p.tip}</SelectItem>
                  ))}
                  <SelectItem value="yeni">Yeni Oluştur</SelectItem>
                </SelectContent>
              </Select>

              <Select value={seciliSevkiyatYetkilisi} onValueChange={(v: any) => setSeciliSevkiyatYetkilisi(v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Sevkiyat yetkilisi" />
                </SelectTrigger>
                <SelectContent>
                  {(selectedSiparis?.paketleyenler || []).map((ad, i) => (
                    <SelectItem key={i} value={ad}>{ad}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                type="number"
                placeholder="Atanacak Adet"
                value={sevkiyatGroup ? sevkiyatQty : 1}
                onChange={(e) => {
                  const v = parseInt(e.target.value || '1', 10);
                  if (sevkiyatGroup) setSevkiyatQty(Math.max(1, Math.min(sevkiyatGroup.kalan, isNaN(v) ? 1 : v)));
                }}
              />

              {hata && <div className="text-red-600 text-sm">{hata}</div>}

              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setSevkiyatModalOpen(false)}>İptal</Button>
                <Button onClick={() => (sevkiyatGroup ? commitSevkiyatAtaGroup() : commitSevkiyatAta())}>Kaydet</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
        </Card>
      )}

      {aktifAsama === "yukleme" && (
        <Card className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold">Yükleme Alanı</h2>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                title="Saha Montaj'a geç"
                onClick={() => { setSahaBasladi(true); setAktifAsama('saha'); }}
              >
                Saha Montaj'a Geç
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-4">
            <Input placeholder="Kamyon / Araç No" />
            <Input placeholder="Şoför Adı" />
            <Input type="date" placeholder="Yükleme Tarihi" />
            <Input placeholder="Not" />
          </div>
          <div className="text-sm text-muted-foreground mb-2">Barkod ile palet/sandık doğrulaması yapılabilir (entegrasyon burada).</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>No</TableHead>
                <TableHead>Tip</TableHead>
                <TableHead>Kutu/Poşet Kaynakları</TableHead>
                <TableHead>Toplam Adet</TableHead>
                <TableHead>Araç Türü</TableHead>
                <TableHead>Araç No / Plaka</TableHead>
                <TableHead>Şoför Adı</TableHead>
                <TableHead>Yazdır</TableHead>
                <TableHead>Durum</TableHead>
                <TableHead>Aksiyon</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paletlerFlat.filter(p => p.tip === "Palet" || p.tip === "Sandık").map((p, i) => (
                <TableRow key={i}>
                  <TableCell>{p.no}</TableCell>
                  <TableCell>{p.tip}</TableCell>
                  <TableCell>
                    {(() => { const kids = getParentChildren(p.no); return kids.length ? kids.join(", ") : "-"; })()}
                  </TableCell>
                  <TableCell>{p.adet}</TableCell>
                  <TableCell>
                    <Select
                      value={p.aracTuru ?? undefined}
                      onValueChange={(v: string) => updateContainer(p.no, { aracTuru: v })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Araç türü seç" />
                      </SelectTrigger>
                      <SelectContent>
                        {ARAC_TURLERI.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input
                      placeholder="Araç No / Plaka"
                      value={p.aracNo || ""}
                      onChange={(e) => updateContainer(p.no, { aracNo: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      placeholder="Şoför Adı"
                      value={p.soforAdi || ""}
                      onChange={(e) => updateContainer(p.no, { soforAdi: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => openContainerPrint(p.no)}>
                      🖨️ Yazdır
                    </Button>
                  </TableCell>
                  <TableCell>
                    {p.durum === "Kamyona Yüklendi" ? (
                      <span className="px-2 py-0.5 text-xs rounded-full bg-green-100 border border-green-300 text-green-800">
                        Kamyona Yüklendi
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 text-xs rounded-full bg-amber-100 border border-amber-300 text-amber-800">
                        {p.durum || "Hazırlanıyor"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {p.durum === "Kamyona Yüklendi" ? (
                      <span className="text-xs text-muted-foreground">Tamamlandı</span>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => markLoaded(p.no)}>
                        Kamyona Yüklendi
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {paletlerFlat.filter(p => p.tip === "Palet" || p.tip === "Sandık").length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-xs text-muted-foreground">Yüklemeye hazır palet/sandık bulunmuyor.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Print Preview Dialog */}
      <Dialog open={printOpen} onOpenChange={setPrintOpen}>
        <DialogContent className="max-w-3xl w-[95vw] overflow-hidden print-container">
          <DialogHeader>
            <DialogTitle>Yazdırma Önizleme</DialogTitle>
          </DialogHeader>
          {printTarget && (
            <div className="space-y-4">
              {printTarget.type === "container" ? (
                (() => {
                  const data = getContainerPrintData(printTarget.containerNo);
                  return (
                    <div className="rounded border bg-white p-4 space-y-4 box-border">
                      {/* Header */}
                      <div className="grid grid-cols-1 md:grid-cols-[1fr_180px] gap-4 items-start">
                        <div className="space-y-1">
                          <div className="text-xl font-bold">Sipariş No: {data.siparis}</div>                          
                          <div className="text-sm text-muted-foreground">Palet / Sandık: {data.no}</div>

                          <div className="text-sm text-muted-foreground">Müşteri: {data.musteri || '-'}</div>
                          <div className="text-xs text-muted-foreground">Tarih: {new Date().toLocaleDateString()}</div>
                        </div>
                        <div className="w-[180px] justify-self-end flex flex-col items-center gap-2">
                          {qrMap[data.no] && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={qrMap[data.no]} alt="qr" className="w-24 h-24" />
                          )}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={arnikonLogo.src} alt="Arnikon" className="opacity-90 object-contain" style={{ height: '24px', width: 'auto' }} />
                        </div>
                      </div>

                      <div className="mt-2 mb-3 text-sm">
                        <div className="border rounded p-2">
                          <div className="font-medium">Kabul / Teslim Bilgileri</div>
                          <div className="mt-1">Kabul Eden: <span className="font-semibold">{data.teslimAldi || "-"}</span></div>
                          <div>Tarih: <span className="font-semibold">{data.teslimTarihi || "-"}</span></div>
                          <div>Yer: <span className="font-semibold">{data.teslimYeri || "-"}</span></div>
                          <div>Not: <span className="font-semibold">{data.teslimNotu || "-"}</span></div>
                          <div>Durum: <span className={`font-semibold ${data.teslimOnay ? "text-green-700" : "text-gray-600"}`}>{data.teslimOnay ? "Kabul Edildi" : "Beklemede"}</span></div>
                        </div>
                      </div>

                      {/* Info box: Sevkiyat bilgileri */}
                      <div className="text-sm">
                        <div className="space-y-1 border rounded p-2">
                          <div className="font-semibold text-xs uppercase text-muted-foreground">Sevkiyat</div>
                          <div><b>Yetkili:</b> {data.sevkiyatYetkilisi || 'Mehmet KARAKAYA'}</div>
                          <div><b>Araç Türü:</b> {data.aracTuru || '-'}</div>
                          <div><b>Araç No / Plaka:</b> {data.aracNo || '-'}</div>
                          <div><b>Şoför Adı:</b> {data.soforAdi || '-'}</div>
                        </div>
                      </div>

                      {/* Palet bilgisi üstte */}
                      <div className="text-sm border rounded p-2">
                        <div className="font-semibold text-xs uppercase text-muted-foreground">Palet</div>
                        <div><b>Tip:</b> Palet ({data.countPalet || 0}) · Sandık ({data.countSandik || 0})</div>
                      </div>

                      {/* Items: yalnız ürün bilgisi (üst başlık kaldırıldı) */}
                      <div className="space-y-1">
                        <Table className="table-fixed">
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-2/3 whitespace-normal">Ürün</TableHead>
                              <TableHead className="w-24 text-right">Adet</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {data.items.map((l, idx) => (
                              <TableRow key={`${data.no}-toplam-${idx}`}>
                                <TableCell className="whitespace-normal break-words align-top">{l.kod} - {l.ad}</TableCell>
                                <TableCell className="text-right">{l.adet}</TableCell>
                              </TableRow>
                            ))}
                            {data.items.length === 0 && (
                              <TableRow>
                                <TableCell colSpan={2} className="text-xs text-muted-foreground">
                                  Bu palette ürün kaydı bulunmuyor
                                </TableCell>
                              </TableRow>
                            )}
                          </TableBody>
                        </Table>
                      </div>

                      {/* Kutu / Poşet Özeti */}
                      {data.children && data.children.length > 0 && (
                        <div className="space-y-1">
                          <div className="font-semibold text-sm">Kutu / Poşet Özeti</div>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>No</TableHead>
                                <TableHead>İstasyon</TableHead>
                                <TableHead className="text-right">Toplam</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {data.children.map((child, idx) => (
                                <TableRow key={`${data.no}-child-${idx}`}>
                                  <TableCell>{child.no}</TableCell>
                                  <TableCell>{child.istasyon || '-'}</TableCell>
                                  <TableCell className="text-right">{child.toplam}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}

                      
                    </div>
                  );
                })()
              ) : printTarget.type === "station" ? (
                (() => {
                  const data = getStationPrintData(printTarget.product);
                  if (!data) return null;
                  const qrKey = `station:${data.urun.kod}`;
                  return (
                    <div className="border rounded p-4 space-y-3">
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                          <div className="text-xl font-bold">Ürün: {data.urun.ad}</div>
                          <div className="text-sm text-muted-foreground">Kod: {data.urun.kod}</div>
                          <div className="text-sm text-muted-foreground">İstasyon: {data.urun.istasyon || '-'}</div>
                          <div className="text-sm text-muted-foreground">Sipariş: {data.siparis} · Müşteri: {data.musteri}</div>
                          <div className="text-xs text-muted-foreground">Tarih: {new Date().toLocaleDateString()}</div>
                        </div>
                        {qrMap[qrKey] && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={qrMap[qrKey]} alt="station-qr" className="w-24 h-24" />
                        )}
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                        <div className="space-y-1 border rounded p-2">
                          <div className="font-semibold text-xs uppercase text-muted-foreground">Özet</div>
                          <div><b>Toplam Atanan:</b> {data.toplamAtanan}</div>
                          <div><b>Kalan:</b> {data.kalan}</div>
                        </div>
                        <div className="space-y-1 border rounded p-2 md:col-span-2">
                          <div className="font-semibold text-xs uppercase text-muted-foreground">Not</div>
                          <div>İstasyon bazlı dağıtımlar ve paketleyen bilgileri aşağıda listelenmiştir.</div>
                        </div>
                      </div>

                      <div className="space-y-1">
                        <div className="font-semibold text-sm">Atanan Paketler</div>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Paket No</TableHead>
                              <TableHead>Tip</TableHead>
                              <TableHead>Adet</TableHead>
                              <TableHead>Kutu Tipi</TableHead>
                              <TableHead>Paketleyen</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {data.assignments.length > 0 ? (
                              data.assignments.map((row, idx) => (
                                <TableRow key={`${data.urun.kod}-assign-${idx}`}>
                                  <TableCell>{row.paketNo}</TableCell>
                                  <TableCell>{row.tip || '-'}</TableCell>
                                  <TableCell>{row.adet}</TableCell>
                                  <TableCell>{row.kutuTipi || '-'}</TableCell>
                                  <TableCell>{row.paketleyen || '-'}</TableCell>
                                </TableRow>
                              ))
                            ) : (
                              <TableRow>
                                <TableCell colSpan={5} className="text-xs text-muted-foreground">
                                  Bu ürüne ait atama bulunmuyor
                                </TableCell>
                              </TableRow>
                            )}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  );
                })()
              ) : printTarget.type === "shipmentGroup" ? (
                (() => {
                  const data = getShipmentGroupPrintData(printTarget.groupKey);
                  if (!data) return null;
                  const qrKey = `shipment:${data.key}`;
                  return (
                    <div className="border rounded p-4 space-y-3">
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                          <div className="text-xl font-bold">İstasyon Grubu: {data.paketNoOzet}</div>
                          <div className="text-sm text-muted-foreground">Tip: Palet ({data.countPalet || 0}) · Sandık ({data.countSandik || 0})</div>
                          <div className="text-sm text-muted-foreground">Sipariş: {data.siparis} · Müşteri: {data.musteri}</div>
                          <div className="text-xs text-muted-foreground">Tarih: {new Date().toLocaleDateString()}</div>
                        </div>
                        {qrMap[qrKey] && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={qrMap[qrKey]} alt="shipment-qr" className="w-24 h-24" />
                        )}
                      </div>

                      <div className="space-y-1">
                        <div className="font-semibold text-sm">Palet ve Kutu Detayı</div>
                        {data.assigned.length > 0 ? (
                          data.assigned.map((row, idx) => (
                            <div key={`${data.key}-palet-${idx}`} className="rounded border divide-y">
                              <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-muted/40 text-sm">
                                <div className="font-semibold">{row.paletNo} · {row.tip}</div>
                                <div className="text-xs text-muted-foreground">Sevkiyat Sorumlusu: {row.sevkiyatYetkilisi}</div>
                                <div className="text-xs text-muted-foreground">Toplam Adet: {row.toplamAdet}</div>
                                <div className="text-xs text-muted-foreground">Kutu / Poşet: {row.kapsulSayisi}</div>
                              </div>
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>Kutu/Poşet No</TableHead>
                                    <TableHead>İstasyon</TableHead>
                                    <TableHead>Tip</TableHead>
                                    <TableHead>Toplam Adet</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {data.children
                                    .filter((child) => getChildParent(child.no) === row.paletNo)
                                    .map((child, childIdx) => (
                                      <TableRow key={`${row.paletNo}-child-${childIdx}`}>
                                        <TableCell>{child.no}</TableCell>
                                        <TableCell>{child.istasyon || '-'}</TableCell>
                                        <TableCell>{child.tip || '-'}</TableCell>
                                        <TableCell>{child.toplam}</TableCell>
                                      </TableRow>
                                    ))}
                                  {data.children.filter((child) => getChildParent(child.no) === row.paletNo).length === 0 && (
                                    <TableRow>
                                      <TableCell colSpan={4} className="text-xs text-muted-foreground">Bu palete ait kutu/poşet bulunmuyor.</TableCell>
                                    </TableRow>
                                  )}
                                </TableBody>
                              </Table>
                            </div>
                          ))
                        ) : (
                          <div className="text-xs text-muted-foreground">Bu gruba atanmış palet veya sandık yok.</div>
                        )}
                      </div>
                    </div>
                  );
                })()
              ) : printTarget.type === "label" ? (
                (() => {
                  const u = urunler.find(x => x.kod === printTarget.product);
                  if (!u) return null;
                  const qrKey = `label:${u.kod}`;
                  const qty = parseQtyText(u.adetText ?? u.adet ?? 0);
                  const paketleyen = getLastPaketleyen(u) || '-';
                  const siparisNo = selectedSiparis?.no || siparisler[0].no;
                  const musteri = selectedSiparis?.musteriAdi || siparisler[0].musteriAdi;
                  const parent = getLastParentContainer(u);
                  const boxType = getLastBoxType(u);
                  return (
                    <div className="border rounded p-6 space-y-4 max-w-3xl">
                      <div className="flex items-start justify-between gap-6">
                        <div className="space-y-1">
                          <div className="text-2xl font-bold tracking-wide">Ürün Etiketi</div>
                          {(() => {
                            const target = "KY ÇKK D250 - KÖPRÜ SON MONTAJ BAĞLANTI ELEMANLARI -";
                            const isTarget = (u.ad || "").trim() === target;
                            return (
                              <div className={isTarget ? "text-xs leading-tight" : "text-lg"}>
                                <b>Ürün:</b> {u.ad}
                              </div>
                            );
                          })()}
                          <div className="text-base text-muted-foreground"><b>Kod:</b> {u.stokKodu || u.kod}</div>
                          <div className="text-base"><b>Adet:</b> {qty} {u.birim || 'Adet'}</div>
                          {paketleyen && <div className="text-base"><b>Paketleyen:</b> {paketleyen}</div>}
                          {parent?.no && <div className="text-base"><b>Paket No:</b> {parent.no}</div>}
                          {parent?.tip && <div className="text-base"><b>Tip:</b> {parent.tip}</div>}
                          {boxType && <div className="text-base"><b>Kutu Tipi:</b> {boxType}</div>}
                          <div className="text-base"><b>Sipariş:</b> {siparisNo}</div>
                          <div className="text-base"><b>Müşteri:</b> {musteri}</div>
                          <div className="text-sm text-muted-foreground">Tarih: {new Date().toLocaleDateString()}</div>
                        </div>
                        <div className="flex flex-col items-center gap-2">
                          {qrMap[qrKey] && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={qrMap[qrKey]} alt="label-qr" className="w-45" />
                          )}
                          {/* Yükseklik 48px, oran korunsun */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={arnikonLogo.src}
                            alt="Arnikon"
                            className="opacity-90 object-contain"
                            style={{ height: '24px', width: 'auto', maxWidth: 'none' }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })()
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="text-base font-semibold">Sipariş: {printTarget.orderNo}</div>
                    {/* QR IMAGE REMOVED FOR ORDER PRINT */}
                  </div>
                  <div className="text-sm">Müşteri: {siparisler.find(si => si.no === printTarget.orderNo)?.musteriAdi || "-"}</div>
                  <div className="text-sm">İstasyon: {siparisler.find(si => si.no === printTarget.orderNo)?.istasyonAdi || "-"}</div>
                  <div className="text-sm">Paketleyen(ler): {(siparisler.find(si => si.no === printTarget.orderNo)?.paketleyenler || []).join(", ")}</div>

                  <div className="border rounded p-3">
                    <div className="text-sm font-medium">Palet / Sandık Bazında Ürün Detayı</div>
                    <Table className="mt-2">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Palet/Sandık No</TableHead>
                          <TableHead>Tip</TableHead>
                          <TableHead>Ürün</TableHead>
                          <TableHead>Adet</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {getOrderContainers(printTarget.orderNo).flatMap((c, idx) => {
                          const lines = getContainerLines(c.no);
                          if (lines.length === 0) {
                            return [
                              <TableRow key={`${c.no}-empty`}>
                                <TableCell>{c.no}</TableCell>
                                <TableCell>{c.tip}</TableCell>
                                <TableCell colSpan={2} className="text-muted-foreground text-xs">
                                  Bu palet/sandıkta ürün bulunmuyor
                                </TableCell>
                              </TableRow>
                            ];
                          }
                          return lines.map((l, i) => (
                            <TableRow key={`${c.no}-${i}`}>
                              <TableCell>{c.no}</TableCell>
                              <TableCell>{c.tip}</TableCell>
                              <TableCell>{l.kod} - {l.ad}</TableCell>
                              <TableCell>{l.adet}</TableCell>
                            </TableRow>
                          ));
                        })}
                        {getOrderContainers(printTarget.orderNo).length === 0 && (
                          <TableRow>
                            <TableCell colSpan={4} className="text-muted-foreground text-xs">
                              Bu siparişe ait palet veya sandık bulunmuyor
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="text-sm mt-2">
                    {(() => {
                      const oc = getOrderContainers(printTarget.orderNo);
                      const paletCount = oc.filter(c => c.tip === "Palet").length;
                      const sandikCount = oc.filter(c => c.tip === "Sandık").length;
                      return (<span>Toplam: {sandikCount} Sandık, {paletCount} Palet</span>);
                    })()}
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button className="no-print" variant="secondary" onClick={() => setPrintOpen(false)}>
                  Kapat
                </Button>
                <Button
                  className="no-print"
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

      {/* Uyarı Popup */}
      <Dialog open={alertOpen} onOpenChange={setAlertOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uyarı</DialogTitle>
          </DialogHeader>
          <div className="text-sm">{alertMsg}</div>
          <div className="flex justify-end mt-3">
            <Button onClick={() => setAlertOpen(false)}>Tamam</Button>
          </div>
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

              {aktifAsama === "sevkiyat" ? (
                <p>
                  <b>Sevkiyat Yetkilisi:</b> {seciliSevkiyatYetkilisi || "-"}
                </p>
              ) : (
                <p>
                  <b>Paketleyen:</b> {selectedUrun.istasyon ? (ISTASYON_PAKETLEYEN[selectedUrun.istasyon] || "-") : "-"}
                </p>
              )}

              {aktifAsama === "sevkiyat" && (
                <Select value={seciliSevkiyatYetkilisi} onValueChange={(v: any) => setSeciliSevkiyatYetkilisi(v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Sevkiyat yetkilisi seç" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_SEVKIYAT_YETKILISI}>{DEFAULT_SEVKIYAT_YETKILISI}</SelectItem>
                  </SelectContent>
                </Select>
              )}

              {aktifAsama === "sevkiyat" && (
                <Input
                  placeholder="Kutu Tipi / Paket Yapısı (örn. 2x3, 1 set, vs.)"
                  value={paketYapisi}
                  onChange={(e) => setPaketYapisi(e.target.value)}
                />
              )}

              <Select
                onValueChange={(v: any) => {
                  setPaketTipi(v);
                  setSeciliKonteyner("");
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder={aktifAsama === "sevkiyat" ? "Paket Tipi Seç (Palet / Sandık)" : "Paket Tipi Seç (Kutu / Poşet)"} />
                </SelectTrigger>
                <SelectContent>
                  {aktifAsama === "sevkiyat" ? (
                    <>
                      <SelectItem value="palet">Palet</SelectItem>
                      <SelectItem value="sandik">Sandık</SelectItem>
                    </>
                  ) : (
                    <>
                      <SelectItem value="kutu">Kutu</SelectItem>
                      <SelectItem value="poset">Poşet</SelectItem>
                    </>
                  )}
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
                  {mevcutListesi
                    .filter(p => {
                      if (aktifAsama !== 'istasyon') return true;
                      if (!(p.tip === 'Kutu' || p.tip === 'Poşet')) return true;
                      const sk = selectedUrun?.istasyon ? ISTASYON_KOD[selectedUrun.istasyon] : undefined;
                      return sk ? p.no.startsWith(`${sk}-`) : true;
                    })
                    .map((p, i) => (
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
                <Button
                  variant="default"
                  onClick={kaydetAtama}
                  disabled={aktifAsama === "sevkiyat" && (
                    parseQtyText((selectedUrun.sevkiyatText ?? selectedUrun.sevkiyatQty) ?? 0) < parseQtyText(selectedUrun.adetText ?? selectedUrun.adet)
                    || adet > parseQtyText((selectedUrun.sevkiyatText ?? selectedUrun.sevkiyatQty) ?? 0)
                    || !seciliSevkiyatYetkilisi
                  )}
                  title={aktifAsama === "sevkiyat" ? (
                    (() => {
                      const sevk = parseQtyText((selectedUrun.sevkiyatText ?? selectedUrun.sevkiyatQty) ?? 0);
                      const prod = parseQtyText(selectedUrun.adetText ?? selectedUrun.adet);
                      if (sevk < prod) return `Sevk Depo Miktarı (${sevk}) Miktardan (${prod}) az`;
                      if (adet > sevk) return `Paketlenecek adet (${adet}) sevk depo (${sevk}) üstünde`;
                      if (!seciliSevkiyatYetkilisi) return 'Sevkiyat yetkilisi seçiniz';
                      return 'Kaydet';
                    })()
                  ) : 'Kaydet'}
                >
                  Kaydet
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );

      {/* PACKING LIST ÖNİZLEME / PRINT DIALOG */}
      <Dialog open={packingListOpen} onOpenChange={setPackingListOpen}>
        <DialogContent className="w-[98vw] max-w-[1250px] max-h-[95vh] overflow-auto p-0 print-container">
          <div className="packing-page bg-white text-black">
            {/* Logo + Title Bar */}
            <div className="pt-6 px-10 flex flex-col items-center gap-4">
              <Image
                src={arnikonLogo}
                alt="Arnikon Logo"
                className="h-16 w-auto"
              />
              <div className="w-full pl-box overflow-hidden">
                <div className="pl-head text-center py-3 text-lg font-semibold tracking-[0.12em]">
                  PACKING LIST
                </div>
              </div>
            </div>

            {/* Invoice / Date row */}
            <div className="mt-6 px-10 flex gap-4 text-xs">
              <div className="flex-1 pl-box px-4 py-3">
                <div className="font-semibold mb-1">INVOICE NO :</div>
                <div className="text-base font-semibold">
                  {packingListData.invoiceNo}
                </div>
              </div>
              <div className="flex-1 pl-box px-4 py-3">
                <div className="font-semibold mb-1 text-right">DATE :</div>
                <div className="text-base font-semibold text-right">
                  {packingListData.date}
                </div>
              </div>
            </div>

            {/* Supplier / Consignee */}
            <div className="mt-4 px-10 flex gap-4 text-xs leading-relaxed">
              <div className="flex-1 pl-box px-4 py-3">
                <div className="font-semibold mb-2">SUPPLIER :</div>
                <div><span className="font-semibold">Company Name :</span> {packingListData.supplier.companyName}</div>
                <div><span className="font-semibold">Address :</span> {packingListData.supplier.address}</div>
                <div><span className="font-semibold">City, State :</span> {packingListData.supplier.city}</div>
                <div><span className="font-semibold">Country :</span> {packingListData.supplier.country}</div>
                <div><span className="font-semibold">Phone :</span> {packingListData.supplier.phone}</div>
                <div><span className="font-semibold">Fax :</span> {packingListData.supplier.fax}</div>
                <div><span className="font-semibold">Email :</span> {packingListData.supplier.email}</div>
              </div>
              <div className="flex-1 pl-box px-4 py-3">
                <div className="font-semibold mb-2">CONSIGNEE :</div>
                <div><span className="font-semibold">Company Name :</span> {packingListData.consignee.companyName}</div>
                <div><span className="font-semibold">Address :</span> {packingListData.consignee.address}</div>
                <div><span className="font-semibold">City, State :</span> {packingListData.consignee.city}</div>
                <div><span className="font-semibold">Country :</span> {packingListData.consignee.country}</div>
                <div><span className="font-semibold">Phone/ Fax :</span> {packingListData.consignee.phone}</div>
                <div><span className="font-semibold">Email :</span> {packingListData.consignee.email}</div>
              </div>
            </div>

            {/* Items table */}
            <div className="mt-6 px-10 text-xs">
              <table className="w-full border-collapse pl-table text-center">
                <thead>
                  <tr>
                    <th className="w-[40px] py-2">NO</th>
                    <th className="w-[220px] px-2 py-2 text-left">DESCRIPTION OF ITEMS</th>
                    <th className="w-[60px] py-2">UNIT</th>
                    <th className="w-[60px] py-2">QTY</th>
                    <th className="w-[130px] px-2 py-2">DIMENSIONS LxWxH (cm)</th>
                    <th className="w-[110px] px-2 py-2">PACKING TYPE</th>
                    <th className="w-[90px] px-2 py-2">UNIT WEIGHT (kg)</th>
                    <th className="w-[110px] px-2 py-2">TOTAL WEIGHTS (kg)</th>
                  </tr>
                </thead>
                <tbody>
                  {packingListData.items.map((item) => (
                    <tr key={item.no}>
                      <td className="py-2 align-top">{item.no}</td>
                      <td className="px-2 py-2 text-left align-top">{item.description}</td>
                      <td className="py-2 align-top">{item.unit}</td>
                      <td className="py-2 align-top">{formatQty(item.qty)}</td>
                      <td className="px-2 py-2 align-top">{item.dimensions}</td>
                      <td className="px-2 py-2 align-top whitespace-pre-line">{item.packingType}</td>
                      <td className="px-2 py-2 align-top text-right">{formatWeight(item.unitWeight)}</td>
                      <td className="px-2 py-2 align-top text-right font-semibold">{formatWeight(item.totalWeight)}</td>
                    </tr>
                  ))}

                  {/* Total text row */}
                  <tr className="pl-total-row">
                    <td colSpan={6} className="px-4 py-3 text-left font-semibold">
                      {packingListData.totalText}
                    </td>
                    <td className="px-2 py-3 text-center align-middle font-semibold">
                      TOTAL WEIGHTS (kg)
                    </td>
                    <td className="px-2 py-3 text-right font-semibold">
                      {formatWeight(packingListTotalWeight)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Origin band */}
            <div className="mt-4 mx-10 text-center pl-origin text-xs py-2 uppercase">
              THAT GOODS ARE TURKISH ORIGIN AND 2025 MODEL
            </div>

            {/* Footer weights / vessel / ports */}
            <div className="mt-4 px-10 pb-6 text-xs">
              <div className="grid grid-cols-2 gap-y-1 max-w-[520px]">
                <div className="pl-footer-label">NET WEIGHT:</div>
                <div>{formatWeight(packingListData.netWeight)} kg</div>
                <div className="pl-footer-label">GROSS WEIGHT:</div>
                <div>{formatWeight(packingListData.grossWeight)} kg</div>
                <div className="pl-footer-label">ONLY 5 CAP</div>
                <div>-</div>
              </div>

              <div className="mt-4 grid grid-cols-[auto,1fr] gap-y-1 max-w-[520px]">
                <div className="pl-footer-label">VESSEL &amp; VOYAGE NO:</div>
                <div>{packingListData.vessel}</div>
                <div className="pl-footer-label">PORT OF LOADING:</div>
                <div>{packingListData.portLoading}</div>
                <div className="pl-footer-label">PORT OF DISCHARGE:</div>
                <div>{packingListData.portDischarge}</div>
              </div>
            </div>

            {/* Dialog actions (screen only) */}
            <div className="no-print px-10 pb-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setPackingListOpen(false)}>
                Kapat
              </Button>
              <Button size="sm" onClick={() => window.print()}>
                Yazdır
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
