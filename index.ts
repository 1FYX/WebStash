import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

const app = express();
const port = 8188;

// 留言数据文件路径
const dataDir = path.join(process.cwd(), 'data');
const messagesFile = path.join(dataDir, 'messages.json');

// 确保data目录存在
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// 确保messages.json存在
if (!fs.existsSync(messagesFile)) {
  fs.writeFileSync(messagesFile, '[]', 'utf8');
}

// 创建HTTP服务器并集成Socket.IO
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: ['http://127.0.0.1:*', 'http://localhost:*', 'http://*:*'],
    credentials: true,
    methods: ['GET', 'POST']
  },
  allowEIO3: true,
  transports: ['websocket', 'polling']
});

// 配置CORS - 允许所有本地端口访问
app.use(cors({
  origin: ['http://127.0.0.1:*', 'http://localhost:*', 'http://*:*','http://127.0.0.1:6001',],
  credentials: true,
  methods: ['GET', 'POST'], // 允许的请求方法
  allowedHeaders: ['Content-Type'] // 允许的请求头
}));

// 配置EJS模板引擎
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

// 创建public目录（如果不存在）
const publicDir = path.join(process.cwd(), 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
  console.log('Created public directory for file serving');
}

// 配置multer文件上传 - 保留原始文件名
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = req.query.path ? path.join(publicDir, req.query.path as string) : publicDir;
    // 确保目录存在
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    // 保留原始文件名，处理中文文件名
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    cb(null, originalName);
  }
});
const upload = multer({ storage });

// 配置静态文件服务
app.use(express.static(publicDir, {
  dotfiles: 'ignore',
  setHeaders: (res, path) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'public, max-age=3600');
  }
}));

// 目录浏览API - 返回文件和目录列表
app.get('/api/browse', async (req, res) => {
  try {
    const subPath = (req.query.path as string) || '';
    const targetDir = path.join(publicDir, subPath);

    // 安全检查：确保路径在publicDir内
    const resolvedPath = path.resolve(targetDir);
    if (!resolvedPath.startsWith(publicDir)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const items = await fs.promises.readdir(targetDir, { withFileTypes: true });
    const result = items
      .filter(item => !item.name.startsWith('.')) // 隐藏文件
      .map(item => ({
        name: item.name,
        isDirectory: item.isDirectory(),
        size: item.isFile() ? fs.statSync(path.join(targetDir, item.name)).size : 0,
        modified: fs.statSync(path.join(targetDir, item.name)).mtime
      }))
      .sort((a, b) => {
        // 目录排在前面，然后按名称排序
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

    res.json(result);
  } catch (error) {
    console.error('Directory read error:', error);
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

// 检查文件是否存在
app.get('/api/check-file', (req, res) => {
  try {
    const filePath = req.query.path as string;
    const fileName = req.query.name as string;

    if (!fileName) {
      res.status(400).json({ error: '文件名不能为空' });
      return;
    }

    const fullPath = path.join(publicDir, filePath || '', fileName);
    const resolvedPath = path.resolve(fullPath);

    // 安全检查
    if (!resolvedPath.startsWith(publicDir)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const exists = fs.existsSync(resolvedPath);
    res.json({ exists });
  } catch (error) {
    res.status(500).json({ error: '检查失败' });
  }
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 留言API - 获取所有留言
app.get('/api/messages', (req, res) => {
  try {
    const messages = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read messages' });
  }
});

// 留言API - 提交新留言
app.post('/api/messages', (req, res) => {
  try {
    const { name, content } = req.body;

    if (!content || !content.trim()) {
      res.status(400).json({ error: '留言内容不能为空' });
      return;
    }

    const messages = JSON.parse(fs.readFileSync(messagesFile, 'utf8'));
    const newMessage = {
      id: Date.now().toString(),
      name: name?.trim() || '匿名用户',
      content: content.trim(),
      timestamp: new Date().toISOString()
    };

    messages.unshift(newMessage); // 新留言放在前面

    // 限制最多保存100条留言
    if (messages.length > 100) {
      messages.pop();
    }

    fs.writeFileSync(messagesFile, JSON.stringify(messages, null, 2), 'utf8');

    // 通过WebSocket广播新留言
    io.emit('newMessage', newMessage);

    res.json(newMessage);
  } catch (error) {
    res.status(500).json({ error: 'Failed to save message' });
  }
});

// 文件列表路由
app.get('/', (req, res) => {
  fs.readdir(publicDir, (err, files) => {
    if (err) {
      res.status(500).send('Error reading directory');
      return;
    }
    res.render('index', { files });
  });

});

// 文件列表路由 - 支持上传到指定目录
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const uploadPath = req.query.path || '';
  res.json({
    success: true,
    filename: req.file.originalname,
    path: uploadPath
  });
});

// SSE接口
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // 发送测试数据
  const sendEvent = () => {
    res.write(`data: ${JSON.stringify({time: new Date().toISOString()})}\n\n`);
  };
  
  // 每1秒发送一次事件
  const interval = setInterval(sendEvent, 1000);
  
  // 客户端断开连接时清理
  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// WebSocket连接处理 - 支持本地服务连接
io.on('connection', (socket) => {
  console.log('WebSocket客户端已连接:', socket.id);
  console.log('客户端地址:', socket.handshake.address);
  console.log('客户端来源:', socket.handshake.headers.origin || '直接连接');
  
  // 发送欢迎消息
  socket.emit('welcome', { 
    message: 'WebSocket连接成功', 
    timestamp: new Date().toISOString(),
    serverInfo: {
      port: port,
      publicDir: publicDir,
      availableEndpoints: ['/sse', '/api/directory', '/upload', '/api/*']
    }
  });
  
  // 处理客户端消息
  socket.on('message', (data) => {
    console.log('收到客户端消息:', data);
    // 回显消息给客户端
    socket.emit('echo', { 
      message: data.message, 
      timestamp: new Date().toISOString(),
      clientId: socket.id
    });
  });
  
  // 处理文件列表请求
  socket.on('getFiles', async (data) => {
    try {
      const files = await fs.promises.readdir(publicDir);
      socket.emit('filesList', { 
        files, 
        timestamp: new Date().toISOString(),
        directory: publicDir
      });
    } catch (error) {
      console.error('读取目录失败:', error);
      socket.emit('error', { error: 'Failed to read directory' });
    }
  });
  
  // 处理特定目录请求
  socket.on('getDirectory', async (data) => {
    try {
      const targetDir = data.path ? path.join(publicDir, data.path) : publicDir;
      const files = await fs.promises.readdir(targetDir);
      socket.emit('directoryList', { 
        files, 
        path: data.path || '',
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('读取指定目录失败:', error);
      socket.emit('error', { error: 'Failed to read specified directory' });
    }
  });
  
  // 处理文件内容请求
  socket.on('getFileContent', async (data) => {
    try {
      const filePath = path.join(publicDir, data.filename);
      const content = await fs.promises.readFile(filePath, 'utf8');
      socket.emit('fileContent', {
        filename: data.filename,
        content: content,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('读取文件失败:', error);
      socket.emit('error', { error: 'Failed to read file' });
    }
  });
  
  // 处理断开连接
  socket.on('disconnect', (reason) => {
    console.log('WebSocket客户端已断开连接:', socket.id);
    console.log('断开原因:', reason);
  });
});

// 启动服务器
server.listen(port, () => {
  console.log(`File server running at http://localhost:${port}`);
  console.log(`WebSocket server available at ws://localhost:${port}`);
});

// webfloder 本地文件服务器，用于本地测试文件响应