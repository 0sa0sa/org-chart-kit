import type { Member, Org, OrgState } from 'org-chart-kit';

const ORGS: [id: string, name: string, parent: string | null][] = [
  ['root', '株式会社みなもと', null],
  ['plan', '経営企画室', 'root'],
  ['prod', 'プロダクト本部', 'root'],
  ['dev', 'プロダクト開発部', 'prod'],
  ['web', 'Webチーム', 'dev'],
  ['mobile', 'モバイルチーム', 'dev'],
  ['infra', '基盤チーム', 'dev'],
  ['design', 'デザイン室', 'prod'],
  ['biz', 'ビジネス本部', 'root'],
  ['sales', '営業部', 'biz'],
  ['ent', 'エンタープライズ営業', 'sales'],
  ['smb', 'SMB営業', 'sales'],
  ['cs', 'カスタマーサクセス部', 'biz'],
  ['mkt', 'マーケティング部', 'biz'],
  ['corp', 'コーポレート本部', 'root'],
  ['hr', '人事部', 'corp'],
  ['recruit', '採用チーム', 'hr'],
  ['fin', '経理財務部', 'corp'],
];

// [name, title, grade, orgId, isHead]
const MEMBERS: [string, string, string, string, boolean?][] = [
  ['水野 源一', '代表取締役', 'G9', 'root', true],
  ['高橋 美咲', '室長', 'G7', 'plan', true],
  ['石田 航', 'アナリスト', 'G4', 'plan'],
  ['岡本 翔太', '本部長', 'G8', 'prod', true],
  ['中村 拓海', '部長', 'G7', 'dev', true],
  ['小林 さくら', 'リード', 'G5', 'web', true],
  ['加藤 陽介', 'エンジニア', 'G4', 'web'],
  ['吉田 真央', 'エンジニア', 'G3', 'web'],
  ['山口 大輝', 'エンジニア', 'G3', 'web'],
  ['松本 葵', 'リード', 'G5', 'mobile', true],
  ['井上 蓮', 'エンジニア', 'G4', 'mobile'],
  ['木村 結衣', 'エンジニア', 'G2', 'mobile'],
  ['林 健太', 'SRE', 'G5', 'infra'],
  ['清水 悠真', 'SRE', 'G3', 'infra'],
  ['森 彩花', '室長', 'G6', 'design', true],
  ['池田 湊', 'デザイナー', 'G4', 'design'],
  ['橋本 紬', 'デザイナー', 'G3', 'design'],
  ['山本 誠', '本部長', 'G8', 'biz', true],
  ['阿部 隆', '部長', 'G7', 'sales', true],
  ['石川 智也', 'マネージャー', 'G6', 'ent', true],
  ['前田 優奈', '営業', 'G4', 'ent'],
  ['藤田 颯', '営業', 'G3', 'ent'],
  ['後藤 七海', '営業', 'G4', 'smb'],
  ['岡田 陸', '営業', 'G3', 'smb'],
  ['長谷川 萌', '営業', 'G2', 'smb'],
  ['村上 直樹', '部長', 'G6', 'cs', true],
  ['近藤 愛', 'CSM', 'G4', 'cs'],
  ['坂本 悠人', 'CSM', 'G3', 'cs'],
  ['遠藤 楓', 'サポート', 'G2', 'cs'],
  ['青木 千尋', '部長', 'G6', 'mkt', true],
  ['藤井 蒼', 'マーケター', 'G4', 'mkt'],
  ['西村 未来', 'マーケター', 'G3', 'mkt'],
  ['福田 浩二', '本部長', 'G8', 'corp', true],
  ['太田 由美', '部長', 'G6', 'hr', true],
  ['三浦 杏', 'HRBP', 'G4', 'hr'],
  ['藤原 樹', 'リクルーター', 'G4', 'recruit', true],
  ['岡崎 花', 'リクルーター', 'G3', 'recruit'],
  ['松田 修', '部長', 'G6', 'fin', true],
  ['中川 恵', '経理', 'G4', 'fin'],
  ['原田 誠也', '経理', 'G3', 'fin'],
];

/** デモ用の架空の会社（18組織・40名） */
export function sampleOrg(): OrgState {
  const orgs: Record<string, Org> = {};
  for (const [id, name, parentId] of ORGS) orgs[id] = { id, name, parentId, headId: null };
  const members: Record<string, Member> = {};
  MEMBERS.forEach(([name, title, grade, orgId, isHead], i) => {
    const id = `m${i + 1}`;
    members[id] = { id, name, title, grade, orgId };
    if (isHead) orgs[orgId].headId = id;
  });
  return { orgs, members };
}
