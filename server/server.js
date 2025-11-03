require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors({origin: process.env.ALLOW_ORIGIN || 'http://localhost:5173'}));
app.use(express.json());

app.get('/health',(req,res)=>res.send('ok'));

app.post('/api/translate', async (req,res)=>{
  try{
    const {phraseText, contextText} = req.body || {};
    const key = process.env.DEEPL_KEY;
    const url = process.env.DEEPL_URL || 'https://api-free.deepl.com/v2/translate';
    if(!key) return res.status(500).json({error:'DEEPL_KEY missing'});
    const text = `Übersetze möglichst wortwörtlich ins Deutsche (max. 3 Wörter). Phrase: "${phraseText}". Kontext: "${contextText}"`;
    const params = new URLSearchParams({auth_key:key, text, target_lang:'DE'});
    const r = await fetch(url, {method:'POST', body: params});
    const data = await r.json();
    res.json({translatedText: data?.translations?.[0]?.text || ''});
  }catch(e){ console.error(e); res.status(500).json({error:'translate failed'}); }
});

app.post('/api/translate/fulltext', async (req,res)=>{
  try{
    const {fullText} = req.body || {};
    const key = process.env.DEEPL_KEY;
    const url = process.env.DEEPL_URL || 'https://api-free.deepl.com/v2/translate';
    if(!key) return res.status(500).json({error:'DEEPL_KEY missing'});
    const params = new URLSearchParams({auth_key:key, text: fullText || '', target_lang:'DE'});
    const r = await fetch(url, {method:'POST', body: params});
    const data = await r.json();
    res.json({translatedText: data?.translations?.[0]?.text || ''});
  }catch(e){ console.error(e); res.status(500).json({error:'fulltext failed'}); }
});

app.listen(PORT, ()=> console.log('Server listening on', PORT));
