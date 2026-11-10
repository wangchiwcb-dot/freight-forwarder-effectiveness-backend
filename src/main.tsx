import React from 'react';
import ReactDOM from 'react-dom/client';
import '@ant-design/v5-patch-for-react-19';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import { AdminProvider } from './store';
import './styles.css';
import { SessionProvider } from './session';
dayjs.locale('zh-cn');
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ConfigProvider locale={zhCN} theme={{token:{colorPrimary:'#177b70',colorInfo:'#177b70',colorSuccess:'#2d8c6d',colorWarning:'#ce8a32',colorError:'#cf5d57',colorText:'#213c42',colorTextSecondary:'#7a8c90',colorBorder:'#e1e8e8',colorBgLayout:'#f4f7f7',borderRadius:8,controlHeight:36,fontSize:13,fontFamily:'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif'},components:{Table:{headerBg:'#f7f9f9',headerColor:'#6e8285',cellPaddingBlock:16},Button:{primaryShadow:'none'},Menu:{itemHeight:44,itemBorderRadius:7},Tabs:{horizontalItemGutter:30},Drawer:{footerPaddingBlock:16}}}}><AntApp><SessionProvider><AdminProvider><App/></AdminProvider></SessionProvider></AntApp></ConfigProvider></React.StrictMode>
);
