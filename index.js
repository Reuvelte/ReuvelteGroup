const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const Pino = require('pino');

// ========== KONFIGURASI ==========
const PREFIX = '.'; // Ganti dengan prefix yang diinginkan
const ADMIN_NUMBER = '6285964262359'; // Ganti dengan nomor admin utama (pakai kode negara tanpa '+')
const SESSION_FOLDER = './session'; // Folder untuk menyimpan sesi login

// ========== FUNGSI UTAMA ==========
async function startBot() {
    // Setup penyimpanan autentikasi
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

    // Buat koneksi socket
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true, // QR akan muncul di terminal
        browser: Browsers.macOS('Desktop'),
        logger: Pino({ level: 'silent' }), // Set ke 'info' untuk debugging
        generateHighQualityLinkPreview: true,
        getMessage: async (key) => {
            return { conversation: '' };
        }
    });

    // Simpan kredensial saat update
    sock.ev.on('creds.update', saveCreds);

    // Tangani koneksi
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus, menyambung ulang:', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ Bot berhasil terhubung!');
        }
    });

    // ========== HANDLER PESAN ==========
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return; // Abaikan pesan sendiri

        const chatId = msg.key.remoteJid;
        const sender = msg.key.participant || msg.key.remoteJid;
        const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        
        // Hanya proses di grup (ID berakhiran @g.us)
        if (!chatId.endsWith('@g.us')) return;
        
        // Cek apakah pesan dimulai dengan prefix
        if (!messageText.startsWith(PREFIX)) return;

        // Pisahkan perintah dan argumen
        const args = messageText.slice(PREFIX.length).trim().split(/\s+/);
        const command = args.shift().toLowerCase();
        const fullArgs = args.join(' ');

        // Dapatkan informasi grup
        const groupMetadata = await sock.groupMetadata(chatId);
        const groupName = groupMetadata.subject;
        const isAdmin = isUserAdmin(sender, groupMetadata);
        const isBotAdmin = isUserAdmin(sock.user.id.split(':')[0] + '@s.whatsapp.net', groupMetadata);
        const isOwner = sender.split('@')[0] === ADMIN_NUMBER;

        console.log(`[${new Date().toLocaleString()}] ${command} dari ${sender.split('@')[0]} di ${groupName}`);

        // ========== DAFTAR PERINTAH ==========

        // HELP - Menampilkan semua perintah
        if (command === 'help' || command === 'menu') {
            const menuText = `🤖 *BOT GROUP MANAGER* 🤖\n\n*Perintah yang tersedia:*\n\n` +
                `🔓 *${PREFIX}open* - Membuka grup\n` +
                `🔒 *${PREFIX}close* - Menutup grup\n\n` +
                `📢 *${PREFIX}tagall* - Tag semua anggota\n` +
                `👻 *${PREFIX}hidetag* - Tag semua (tersembunyi)\n\n` +
                `➕ *${PREFIX}add 62xxx* - Tambah anggota\n` +
                `❌ *${PREFIX}kick @user* - Keluarkan anggota\n` +
                `👑 *${PREFIX}promote @user* - Jadikan admin\n` +
                `📉 *${PREFIX}demote @user* - Cabut admin\n\n` +
                `🔗 *${PREFIX}link* - Link grup\n` +
                `🚪 *${PREFIX}leave* - Keluar dari grup\n\n` +
                `⚠️ Hanya admin yang bisa menggunakan perintah ini`;
            
            await sock.sendMessage(chatId, { text: menuText });
            return;
        }

        // Cek admin untuk perintah yang membutuhkan akses admin
        if (!isAdmin && command !== 'help' && command !== 'menu') {
            await sock.sendMessage(chatId, { text: '❌ Hanya admin grup yang bisa menggunakan perintah ini!' });
            return;
        }

        // OPEN - Membuka grup
        if (command === 'open') {
            await sock.groupSettingUpdate(chatId, 'not_announcement');
            await sock.sendMessage(chatId, { text: '🔓 *Grup telah dibuka!*\nSemua anggota sekarang bisa mengirim pesan.' });
        }

        // CLOSE - Menutup grup
        else if (command === 'close') {
            await sock.groupSettingUpdate(chatId, 'announcement');
            await sock.sendMessage(chatId, { text: '🔒 *Grup telah ditutup!*\nHanya admin yang bisa mengirim pesan.' });
        }

        // TAGALL - Tag semua anggota
        else if (command === 'tagall') {
            await tagAll(sock, chatId, groupMetadata, '📢 PENGUMUMAN\n\n');
        }

        // HIDETAG - Tag semua tersembunyi
        else if (command === 'hidetag') {
            const text = fullArgs || 'Pesan dari admin';
            await hideTag(sock, chatId, groupMetadata, text);
        }

        // ADD - Menambah anggota
        else if (command === 'add') {
            if (!isBotAdmin) {
                await sock.sendMessage(chatId, { text: '❌ Bot harus menjadi admin grup terlebih dahulu!' });
                return;
            }
            
            let number = fullArgs.replace(/[^0-9]/g, '');
            if (!number) {
                await sock.sendMessage(chatId, { text: '❌ Format: .add 628xxxxxxxxxx' });
                return;
            }
            
            if (!number.endsWith('@s.whatsapp.net')) {
                number = number + '@s.whatsapp.net';
            }
            
            try {
                await sock.groupParticipantsUpdate(chatId, [number], 'add');
                await sock.sendMessage(chatId, { text: `✅ Berhasil menambah @${number.split('@')[0]}`, mentions: [number] });
            } catch (err) {
                await sock.sendMessage(chatId, { text: `❌ Gagal menambah anggota. Pastikan nomor terdaftar di WhatsApp.` });
            }
        }

        // KICK - Mengeluarkan anggota
        else if (command === 'kick') {
            if (!isBotAdmin) {
                await sock.sendMessage(chatId, { text: '❌ Bot harus menjadi admin grup terlebih dahulu!' });
                return;
            }
            
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentioned.length === 0) {
                await sock.sendMessage(chatId, { text: '❌ Tag anggota yang ingin dikeluarkan!\nContoh: .kick @user' });
                return;
            }
            
            try {
                await sock.groupParticipantsUpdate(chatId, mentioned, 'remove');
                await sock.sendMessage(chatId, { text: `✅ Berhasil mengeluarkan ${mentioned.length} anggota` });
            } catch (err) {
                await sock.sendMessage(chatId, { text: `❌ Gagal mengeluarkan anggota.` });
            }
        }

        // PROMOTE - Jadikan admin
        else if (command === 'promote') {
            if (!isBotAdmin) {
                await sock.sendMessage(chatId, { text: '❌ Bot harus menjadi admin grup terlebih dahulu!' });
                return;
            }
            
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentioned.length === 0) {
                await sock.sendMessage(chatId, { text: '❌ Tag anggota yang ingin dijadikan admin!\nContoh: .promote @user' });
                return;
            }
            
            try {
                await sock.groupParticipantsUpdate(chatId, mentioned, 'promote');
                await sock.sendMessage(chatId, { text: `✅ Berhasil mempromosikan ${mentioned.length} anggota menjadi admin` });
            } catch (err) {
                await sock.sendMessage(chatId, { text: `❌ Gagal mempromosikan anggota.` });
            }
        }

        // DEMOTE - Cabut admin
        else if (command === 'demote') {
            if (!isBotAdmin) {
                await sock.sendMessage(chatId, { text: '❌ Bot harus menjadi admin grup terlebih dahulu!' });
                return;
            }
            
            const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (mentioned.length === 0) {
                await sock.sendMessage(chatId, { text: '❌ Tag admin yang ingin dicabut jabatannya!\nContoh: .demote @admin' });
                return;
            }
            
            try {
                await sock.groupParticipantsUpdate(chatId, mentioned, 'demote');
                await sock.sendMessage(chatId, { text: `✅ Berhasil mencabut jabatan admin dari ${mentioned.length} anggota` });
            } catch (err) {
                await sock.sendMessage(chatId, { text: `❌ Gagal mencabut jabatan admin.` });
            }
        }

        // LINK - Dapatkan link grup
        else if (command === 'link') {
            if (!isBotAdmin) {
                await sock.sendMessage(chatId, { text: '❌ Bot harus menjadi admin grup untuk mendapatkan link!' });
                return;
            }
            
            try {
                const code = await sock.groupInviteCode(chatId);
                const link = `https://chat.whatsapp.com/${code}`;
                await sock.sendMessage(chatId, { text: `🔗 *Link Grup:*\n${link}` });
            } catch (err) {
                await sock.sendMessage(chatId, { text: `❌ Gagal mendapatkan link grup. Pastikan bot adalah admin.` });
            }
        }

        // LEAVE - Keluar dari grup
        else if (command === 'leave') {
            if (isOwner) {
                await sock.sendMessage(chatId, { text: '👋 Bot akan keluar dari grup ini. Goodbye!' });
                await sock.groupLeave(chatId);
            } else {
                await sock.sendMessage(chatId, { text: '❌ Hanya owner bot yang bisa menyuruh bot keluar!' });
            }
        }
    });
}

// ========== FUNGSI BANTUAN ==========

// Cek apakah user adalah admin grup
function isUserAdmin(userJid, groupMetadata) {
    const participants = groupMetadata.participants;
    const user = participants.find(p => p.id === userJid);
    return user?.admin === 'admin' || user?.admin === 'superadmin';
}

// Fungsi tag semua anggota
async function tagAll(sock, chatId, groupMetadata, prefixMessage = '') {
    let members = groupMetadata.participants;
    let mentions = members.map(m => m.id);
    
    let messageText = prefixMessage;
    messageText += `Total anggota: ${members.length}\n\n`;
    members.forEach(m => {
        messageText += `• @${m.id.split('@')[0]}\n`;
    });
    
    await sock.sendMessage(chatId, { text: messageText, mentions: mentions });
}

// Fungsi hidetag (tag tersembunyi)
async function hideTag(sock, chatId, groupMetadata, text) {
    let mentions = groupMetadata.participants.map(m => m.id);
    await sock.sendMessage(chatId, { text: text, mentions: mentions });
}

// ========== SERVER UNTUK RENDER ==========
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot WhatsApp Aktif!');
});

app.listen(port, () => {
    console.log(`Server web berjalan di port ${port}`);
});
// ========== AKHIR KODE SERVER ==========

// Pastikan baris ini tetap ada di paling bawah
startBot().catch(err => console.log('Error:', err));

// Jalankan bot
startBot().catch(err => console.log('Error:', err));
