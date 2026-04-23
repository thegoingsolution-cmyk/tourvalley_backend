import { Router, Request, Response } from 'express';

const router = Router();

const KAKAO_ADDRESS_URL = 'https://dapi.kakao.com/v2/local/search/address.json';

/**
 * 브라우저에 키를 내리지 않고, 카카오 주소 검색(도로명) 결과만 반환
 * GET /api/address/kakao-search?query=...
 */
router.get('/api/address/kakao-search', async (req: Request, res: Response) => {
  const raw = String(req.query.query ?? '').trim();
  if (raw.length < 2) {
    return res.json({ success: true, documents: [] as unknown[] });
  }

  const restKey = process.env.KAKAO_REST_API_KEY;
  if (!restKey) {
    return res.status(503).json({
      success: false,
      message: '주소 검색이 설정되지 않았습니다. (KAKAO_REST_API_KEY)',
      documents: [],
    });
  }

  try {
    const url = new URL(KAKAO_ADDRESS_URL);
    url.searchParams.set('query', raw);
    url.searchParams.set('size', '10');

    const kakaoRes = await fetch(url, {
      headers: { Authorization: `KakaoAK ${restKey}` },
    });

    if (!kakaoRes.ok) {
      const text = await kakaoRes.text();
      console.error('Kakao address API error', kakaoRes.status, text);
      let kakaoDetail = text;
      try {
        const j = JSON.parse(text) as { message?: string };
        if (j?.message) kakaoDetail = j.message;
      } catch {
        // ignore
      }
      if (kakaoRes.status === 403) {
        return res.status(403).json({
          success: false,
          message:
            '카카오 앱에서 "Kakao 로컬" (지도·주소) 사용이 꺼져 있습니다. developers.kakao.com → 내 애플리케이션 → 해당 앱 → 앱 설정 → Kakao 로컬 ON 후 저장하세요.',
          kakao_detail: kakaoDetail,
          documents: [],
        });
      }
      return res.status(502).json({
        success: false,
        message: '주소 검색 API 호출에 실패했습니다.',
        kakao_detail: kakaoDetail,
        documents: [],
      });
    }

    const data = (await kakaoRes.json()) as { documents?: unknown[] };
    const documents = Array.isArray(data.documents) ? data.documents : [];

    return res.json({ success: true, documents });
  } catch (e) {
    console.error('kakao-search proxy', e);
    return res.status(500).json({
      success: false,
      message: '주소 검색 중 오류가 발생했습니다.',
      documents: [],
    });
  }
});

export default router;
