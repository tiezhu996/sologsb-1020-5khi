import { render } from '@builder.io/qwik';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (container) void render(container, <App />);
