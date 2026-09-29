import { component$ } from '@builder.io/qwik';
import App from './App';
import './styles.css';

export default component$(() => (
  <html lang="zh-CN">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="theme-color" content="#173247" />
      <title>档案元数据核对台</title>
    </head>
    <body>
      <App />
    </body>
  </html>
));
