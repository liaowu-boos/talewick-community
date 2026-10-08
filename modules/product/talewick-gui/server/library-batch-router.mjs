import {decodeImport} from './library.mjs';

const messages = {
  INVALID_BATCH_INPUT:[400,'每批需要10篇有效的TXT小说，请检查文件和批次名称。'],
  INVALID_INPUT:[400,'批量请求格式不正确。'], INVALID_ENCODING:[400,'请使用UTF-8或带BOM的UTF-16文本。'],
  INPUT_TOO_LARGE:[413,'当前每篇最多128,000字节、24,000字符。'], FILE_TOO_LARGE:[413,'单篇文件过大。'],
  BATCH_CONFLICT:[409,'这个批次名称已用于另一组文件。'], REQUEST_CONFLICT:[409,'上传标识已用于另一份文件。'],
  DUPLICATE_SOURCE:[409,'文件与已登记资料重复，请查看原有资料。'], BATCH_TARGET_CAPACITY:[409,'当前批量任务最多登记100篇。'],
  CAPACITY_EXCEEDED:[413,'资料库容量已达上限。'], UNKNOWN_BATCH:[404,'找不到这个批次。'],
  BATCH_SERVICE_BUSY:[409,'批量任务仍在执行。'], BATCH_QUEUE_HALTED:[409,'批量任务已中断，请核对保存状态。'],
  BATCH_SERVICE_CLOSED:[503,'批量服务已关闭，请重新启动本机服务。'],
  SOURCE_BINDING_CONFLICT:[409,'资料版本已变化，本次没有覆盖新版本。'],
  RESULT_BINDING_CONFLICT:[409,'结果与登记版本不一致，请检查资料详情。'],
  CHECKED_RESULT_REQUIRED:[409,'分析或索引尚未通过完整检查。'],
  DATA_WAIT_FAILED:[503,'后台尚未确认任务停止，请保留当前服务并检查处理状态。'],
  MODEL_UNAVAILABLE:[503,'分析模型尚未配置。'], BATCH_UNAVAILABLE:[503,'批量拆解服务暂不可用。'],
  PROCESSING_FAILED:[503,'批量操作未完成，已保存的资料和记录保留。'],
};
const fault=code=>Object.assign(new Error(code),{code});
const safe=error=>{const code=Object.hasOwn(messages,error?.code)?error.code:'PROCESSING_FAILED';return{status:messages[code][0],error:{code,message:messages[code][1],retryable:false}};};
const object=(body,keys=[])=>{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k)))throw fault('INVALID_INPUT');return body;};
const identity=value=>typeof value==='string'&&/^[\w-]{1,160}$/.test(value);

/** Shared host/origin and 2 MiB body checks belong to createRuntime. No operation runs on GET or startup. */
export function createLibraryBatchRouter({service,json,bodyJSON,canRun=()=>true}) {
  const actions=new Map();
  function schedule(key,operation) {
    if(actions.get(key)?.status==='running')throw fault('BATCH_SERVICE_BUSY');
    const action={status:'running',startedAt:new Date().toISOString()};actions.set(key,action);
    // Keep and observe every asynchronous rejection; never expose provider messages.
    action.promise=Promise.resolve().then(operation).then(()=>{action.status='completed';},error=>{action.status='failed';action.error=safe(error).error;}).finally(()=>{action.finishedAt=new Date().toISOString();});
  }
  const progress=()=>({queue:service.progress(),actions:Object.fromEntries([...actions].map(([key,{promise,...value}])=>[key,value]))});
  return async (req,res,url)=>{
    if(!url.pathname.startsWith('/api/library/batches'))return false;
    try {
      const match=url.pathname.match(/^\/api\/library\/batches(?:\/(run|recover)|\/([\w-]{1,160})\/(cancel))?$/);
      if(!match){json(res,404,{error:{code:'NOT_FOUND',message:'找不到这个批量入口。',retryable:false}});return true;}
      const[,action,batchId]=match;
      const allowed=action||batchId?['POST']:['GET','POST'];
      if(!allowed.includes(req.method)){json(res,405,{error:{code:'METHOD_NOT_ALLOWED',message:'此入口不支持当前操作。',retryable:false}});return true;}
      if(!service)throw fault('BATCH_UNAVAILABLE');
      if(req.method==='GET'){json(res,200,progress());return true;}
      const body=await bodyJSON(req);
      if(!action&&!batchId){
        object(body,['batchId','sources']);
        if(!identity(body.batchId)||!Array.isArray(body.sources)||body.sources.length!==10)throw fault('INVALID_BATCH_INPUT');
        // Decode every file before registration; a malformed later file must not register earlier files.
        const sources=body.sources.map(decodeImport);
        await service.addBatch({batchId:body.batchId,sources});json(res,201,progress());
      }else{
        object(body);
        if(action==='run'){
          if(!canRun())throw fault('MODEL_UNAVAILABLE');
          schedule('run',()=>service.run());
        }else if(action==='recover')schedule('recover',()=>service.recover());
        else{
          if(!service.progress().batches.some(b=>b.batchId===batchId))throw fault('UNKNOWN_BATCH');
          schedule('cancel:'+batchId,()=>service.cancelBatch(batchId));
        }
        json(res,202,progress());
      }
    }catch(error){
      if(!error.code&&[400,413,415].includes(error.status))json(res,error.status,{error:{code:error.status===413?'REQUEST_TOO_LARGE':'INVALID_INPUT',message:error.status===413?'请求正文超过2 MiB。':'请求需要有效的JSON正文。',retryable:false}});
      else{const result=safe(error);json(res,result.status,{error:result.error});}
    }
    return true;
  };
}
